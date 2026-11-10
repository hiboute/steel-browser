import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { PlatformStore } from "../platform/store.js";
import type { Session, SessionService } from "../session.service.js";
import type { Actor } from "../control/access.js";
import { AccessError } from "../control/access.js";
import { bounded } from "../handoff/agent-feature-utils.js";
import type { EgressReport } from "../fleet/egress-diagnostics.js";
import { diagnosticBrowserEpoch } from "../fleet/diagnostic-evidence.js";
export const NETWORK_EVIDENCE_MAX_AGE_MS = 120_000;
export interface Diagnosis {
  id: string;
  sessionId: string;
  ownerId: string;
  at: string;
  observations: Array<{
    component: string;
    status: "pass" | "fail" | "untested";
    confidence: "high" | "medium" | "low";
    evidence: string;
    observedAt?: string;
  }>;
  recovery: Array<{ action: string; reason: string; automatic: false }>;
}
export class DoctorService {
  constructor(
    private store: PlatformStore,
    private sessions: SessionService,
  ) {}
  async diagnose(id: string, actor: Actor) {
    const s = this.sessions.getSession(id);
    if (!s) throw new AccessError("session_not_found", "Session not found", 404);
    const report: Diagnosis = {
      id: randomUUID(),
      sessionId: id,
      ownerId: actor.id,
      at: new Date().toISOString(),
      observations: [],
      recovery: [],
    };
    const add = (
      component: string,
      status: "pass" | "fail" | "untested",
      evidence: string,
      confidence: "high" | "medium" | "low" = "high",
    ) => report.observations.push({ component, status, evidence, confidence });
    if (s.status !== "live") {
      add("browser", "untested", `Session is ${s.status}`);
      report.recovery.push({
        action: "resume",
        reason: "A live browser is needed for probes",
        automatic: false,
      });
    } else {
      let browser = s.cdpService.getBrowserInstance();
      if (!browser?.connected) {
        add("cdp", "fail", "Browser transport is disconnected");
        report.recovery.push({
          action: "restart_from_checkpoint",
          reason: "CDP transport is unavailable",
          automatic: false,
        });
      } else {
        try {
          await bounded(browser.version(), 2000);
          add("cdp", "pass", "Browser responds to a bounded protocol query");
        } catch {
          add("cdp", "fail", "Browser protocol query exceeded its deadline");
        }
        try {
          const pages = await bounded(browser.pages(), 2000);
          if (!pages.length) add("renderer", "untested", "No page is available");
          else {
            const p = pages[0];
            const state = await bounded(
              p.evaluate(() => ({
                ready: document.readyState,
                password: !!document.querySelector('input[type="password"]'),
                auth: !!document.querySelector(
                  '[autocomplete="one-time-code"], [data-steel-auth-required]',
                ),
                error: !!document.querySelector("[data-steel-application-error]"),
                offline: !navigator.onLine,
              })),
              2000,
            );
            add("renderer", "pass", `Document responds (${state.ready})`);
            add(
              "authentication",
              state.password || state.auth ? "fail" : "untested",
              state.password || state.auth
                ? "Login or verification input is present; authentication loss is possible"
                : "No reliable authentication marker; no logged-in claim",
              state.password || state.auth ? "medium" : "low",
            );
            add(
              "application",
              state.error ? "fail" : "untested",
              state.error
                ? "Owned application error marker is present"
                : "No explicit application diagnostic marker",
              state.error ? "high" : "low",
            );
            if (state.offline) add("network", "fail", "Browser reports offline", "medium");
            const opts = this.sessions.getLaunchOptions(id);
            if (!opts?.proxyUrl) {
              const url = new URL(p.url());
              if (/^https?:$/.test(url.protocol)) {
                try {
                  await bounded(lookup(url.hostname), 2000);
                  add(
                    "host_dns",
                    "pass",
                    "Current origin resolves from the API host (not a browser DNS proof)",
                    "medium",
                  );
                } catch {
                  add(
                    "host_dns",
                    "fail",
                    "Current origin failed a bounded host resolver probe",
                    "medium",
                  );
                }
              } else add("host_dns", "untested", "Current page has no network origin");
            }
          }
        } catch {
          add("renderer", "fail", "A page did not answer a bounded read-only probe");
          report.recovery.push({
            action: "close_unresponsive_tab",
            reason: "Renderer failed to respond; preserve other pages",
            automatic: false,
          });
        }
      }
      await this.networkEvidence(report, s);
    }
    // Fixed descriptions only: never store page text, URLs, cookies, headers, input values, or thrown errors.
    await this.store.write(`diagnostics/${report.id}.json`, report);
    return report;
  }
  private async networkEvidence(report: Diagnosis, session: Session) {
    const proxy = !!this.sessions.getLaunchOptions?.(session.id)?.proxyUrl;
    let stored: EgressReport | null = null;
    try {
      stored =
        (await bounded(
          this.store.read<EgressReport>(`egress-diagnostics/${session.id}.json`),
          2000,
        )) ?? null;
    } catch {
      /* Missing/unavailable evidence never becomes a transport failure. */
    }
    const epoch = diagnosticBrowserEpoch(session);
    const age = stored ? Date.now() - Date.parse(stored.checkedAt) : NaN;
    const fresh =
      stored?.sessionId === session.id &&
      epoch &&
      stored?.browserEpoch === epoch &&
      Number.isFinite(age) &&
      age >= -5000 &&
      age <= NETWORK_EVIDENCE_MAX_AGE_MS &&
      Array.isArray(stored.probes);
    const add = (
      component: string,
      status: "pass" | "fail" | "untested",
      evidence: string,
      confidence: "high" | "medium" | "low" = "medium",
    ) =>
      report.observations.push({
        component,
        status,
        confidence,
        evidence,
        ...(fresh ? { observedAt: new Date(stored!.checkedAt).toISOString() } : {}),
      });
    if (!fresh) {
      add(
        "network_http",
        "untested",
        "No recent browser-origin measurement for this browser launch",
        "low",
      );
      add("dns", "untested", "No recent authoritative DNS evidence for this browser launch", "low");
      if (proxy)
        add(
          "proxy",
          "untested",
          "Configured proxy has no recent browser-origin measurement",
          "low",
        );
      report.recovery.push({
        action: "run_egress_diagnostics",
        reason:
          "Explicitly probe the owned collector, then rerun diagnosis; diagnosis itself does not navigate or launch browser-origin network probes",
        automatic: false,
      });
      return;
    }
    const http = stored!.probes.find((p) => p.channel === "http");
    const dns = stored!.probes.find((p) => p.channel === "dns");
    const failure = stored!.navigationFailure;
    const httpStatus =
      http?.status === "pass" || http?.status === "fail" ? http.status : "untested";
    add(
      "network_http",
      httpStatus,
      httpStatus === "pass"
        ? "Owned collector recently observed this browser's HTTP request"
        : httpStatus === "fail"
        ? "Browser request to the owned collector failed; this alone does not isolate the proxy, network or collector"
        : "Owned collector HTTP measurement was unavailable",
      httpStatus === "pass" ? "high" : "medium",
    );
    if (failure === "name_resolution_failed") {
      add(
        "dns",
        "fail",
        "Chrome reported name resolution failure while navigating to the owned collector",
        "high",
      );
    } else if (dns?.status === "pass") {
      add(
        "dns",
        "pass",
        "Owned authoritative collector observed a nonce DNS query from this browser probe; this does not identify the browser's public HTTP address",
        "high",
      );
    } else if (dns?.status === "fail") {
      add(
        "dns",
        "fail",
        "Authoritative collector did not observe the browser nonce before the deadline; resolver and collector availability are not independently isolated",
      );
    } else {
      add(
        "dns",
        "untested",
        "Authoritative DNS measurement was unavailable; HTTP success is not DNS-route evidence",
        "low",
      );
    }
    if (proxy) {
      if (failure === "proxy_connection_failed") {
        add(
          "proxy",
          "fail",
          "Chrome reported that it could not connect to the configured proxy",
          "high",
        );
      } else if (failure === "proxy_tunnel_failed") {
        add(
          "proxy",
          "fail",
          "Chrome reported that the proxy tunnel could not be established; the underlying proxy or destination cause is not isolated",
          "high",
        );
      } else if (failure === "proxy_authentication_required") {
        add(
          "proxy",
          "fail",
          "Browser navigation reported a proxy authentication challenge or unsupported proxy authentication",
          "high",
        );
      } else if (httpStatus === "pass") {
        add(
          "proxy",
          "pass",
          "Browser HTTP reached the owned collector while this proxy configuration was active; this does not prove every channel or absence of bypass",
        );
      } else {
        add(
          "proxy",
          "untested",
          "Collector or network failure does not independently identify a proxy outage",
          "low",
        );
      }
    }
    if (httpStatus !== "pass" || dns?.status === "fail" || failure) {
      report.recovery.push({
        action: "inspect_egress_diagnostics",
        reason:
          "Inspect the separately authorized browser-origin probe before changing routing or retrying website mutations",
        automatic: false,
      });
    }
  }
  async get(id: string, actor: Actor) {
    if (!/^[\w-]{1,128}$/.test(id))
      throw new AccessError("invalid_diagnosis", "Invalid diagnosis ID", 400);
    const r = await this.store.read<Diagnosis>(`diagnostics/${id}.json`);
    if (!r) throw new AccessError("diagnosis_not_found", "Diagnostic bundle not found", 404);
    if (r.ownerId !== actor.id && actor.role !== "operator")
      throw new AccessError("diagnosis_denied", "Diagnostic bundle belongs to another principal");
    return r;
  }
}
