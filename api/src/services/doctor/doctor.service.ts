import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { PlatformStore } from "../platform/store.js";
import type { SessionService } from "../session.service.js";
import type { Actor } from "../control/access.js";
import { AccessError } from "../control/access.js";
import { bounded } from "../handoff/agent-feature-utils.js";
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
            if (opts?.proxyUrl) {
              add("dns", "untested", "Proxy routing can resolve names outside this process");
              add(
                "proxy",
                "untested",
                "A configured route alone does not prove browser connectivity",
              );
            } else {
              const url = new URL(p.url());
              if (/^https?:$/.test(url.protocol)) {
                try {
                  await bounded(lookup(url.hostname), 2000);
                  add(
                    "dns",
                    "pass",
                    "Current origin resolves from the API host (not a browser DNS proof)",
                    "medium",
                  );
                } catch {
                  add(
                    "dns",
                    "fail",
                    "Current origin failed a bounded host resolver probe",
                    "medium",
                  );
                }
              } else add("dns", "untested", "Current page has no network origin");
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
    }
    // Fixed descriptions only: never store page text, URLs, cookies, headers, input values, or thrown errors.
    await this.store.write(`diagnostics/${report.id}.json`, report);
    return report;
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
