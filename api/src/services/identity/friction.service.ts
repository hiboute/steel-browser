import type { HTTPResponse, Page } from "puppeteer-core";
import type { Session } from "../session.service.js";
import type { HandoffService } from "../handoff.service.js";
import type { PlatformStore } from "../platform/store.js";
import { activePage, bounded, dataSessionId } from "../handoff/agent-feature-utils.js";
import { now, safeOrigin } from "./types.js";

export interface FrictionSignals {
  captcha: boolean;
  twoFactor: boolean;
  loginExpired: boolean;
  status?: number;
  retryAfter?: string;
  redirects?: number;
}
export interface FrictionFinding {
  kind:
    | "captcha"
    | "two_factor"
    | "login_expired"
    | "throttled"
    | "access_denied"
    | "redirect_loop";
  confidence: number;
  reason: string;
  retryAfterMs?: number;
}
export interface FrictionRecord {
  sessionId: string;
  at: string;
  status: "clear" | "waiting" | "resolved" | "paused" | "unavailable";
  finding?: FrictionFinding;
  origin?: string;
  handoffId?: string;
  resolution?: "done" | "cancelled" | "declined" | "expired";
  automaticRetry: false;
}
export function retryAfter(value?: string, time = Date.now()) {
  if (!value) return 30_000;
  const n = Number(value);
  return Math.min(
    3_600_000,
    Math.max(1000, Number.isFinite(n) ? n * 1000 : Date.parse(value) - time || 30_000),
  );
}
export function classifyFriction(s: FrictionSignals): FrictionFinding | undefined {
  if (s.status === 429)
    return {
      kind: "throttled",
      confidence: 1,
      reason: "The main document returned HTTP 429",
      retryAfterMs: retryAfter(s.retryAfter),
    };
  if (s.captcha)
    return {
      kind: "captcha",
      confidence: 0.9,
      reason: "A visible challenge widget or verification prompt was detected",
    };
  if (s.twoFactor)
    return {
      kind: "two_factor",
      confidence: 0.9,
      reason: "A visible one-time-code field or two-factor prompt was detected",
    };
  if (s.loginExpired)
    return {
      kind: "login_expired",
      confidence: 0.8,
      reason: "A visible login form indicates an expired or required session",
    };
  if ((s.redirects ?? 0) >= 8)
    return {
      kind: "redirect_loop",
      confidence: 0.85,
      reason: "The main page navigated repeatedly within fifteen seconds",
    };
  if (s.status === 403)
    return {
      kind: "access_denied",
      confidence: 0.75,
      reason: "The main document returned HTTP 403; the cause needs review",
    };
}
export class FrictionService {
  private attached = new Map<
    string,
    {
      pages: Map<Page, (r: HTTPResponse) => void>;
      observations: Map<
        Page,
        { last?: { status: number; retryAfter?: string; at: number }; redirects: number[] }
      >;
      target: (target: any) => void;
      browser: any;
    }
  >();
  private busy = new Set<string>();
  private scans = new Map<string, Promise<FrictionRecord>>();
  private suppressed = new Map<string, string>();
  private timer: NodeJS.Timeout;
  constructor(
    private d: {
      store: PlatformStore;
      getSession: (id: string) => Session;
      handoffs: HandoffService;
      publish: (type: string, data: unknown, id: string) => void;
      log: (e: unknown) => void;
    },
  ) {
    this.timer = setInterval(() => {
      for (const id of this.attached.keys()) void this.scan(id).catch(d.log);
    }, 10_000);
    this.timer.unref();
  }
  async attach(session: Session) {
    this.detach(session.id);
    const browser = session.cdpService.getBrowserInstance();
    if (!browser) return;
    const entry = {
      pages: new Map<Page, (r: HTTPResponse) => void>(),
      observations: new Map<
        Page,
        { last?: { status: number; retryAfter?: string; at: number }; redirects: number[] }
      >(),
      target: (_target: any) => {},
      browser,
    };
    const attach = async (page: Page | null) => {
      if (!page || entry.pages.has(page)) return;
      const state = {
        redirects: [] as number[],
        last: undefined as { status: number; retryAfter?: string; at: number } | undefined,
      };
      entry.observations.set(page, state);
      page.once("close", () => {
        entry.observations.delete(page);
        entry.pages.delete(page);
      });
      const listener = (r: HTTPResponse) => {
        const req = r.request();
        if (!req.isNavigationRequest() || req.frame() !== page.mainFrame()) return;
        const at = Date.now();
        state.last = { status: r.status(), retryAfter: r.headers()["retry-after"], at };
        state.redirects = state.redirects.filter((t) => t > at - 15_000);
        state.redirects.push(at);
      };
      entry.pages.set(page, listener);
      page.on("response", listener);
    };
    entry.target = (target: any) => {
      void target.page().then(attach).catch(this.d.log);
    };
    browser.on("targetcreated", entry.target);
    this.attached.set(session.id, entry);
    for (const page of await browser.pages()) await attach(page);
  }
  detach(id: string) {
    const entry = this.attached.get(id);
    if (entry) {
      entry.browser.off("targetcreated", entry.target);
      for (const [p, listener] of entry.pages) p.off("response", listener);
      this.attached.delete(id);
    }
    this.suppressed.delete(id);
  }
  async get(id: string) {
    dataSessionId(id);
    return (
      (await this.d.store.read<FrictionRecord>(`identity/friction/${id}.json`)) ??
      ({
        sessionId: id,
        at: now(),
        status: "clear",
        automaticRetry: false,
      } satisfies FrictionRecord)
    );
  }
  async resolved(id: string, resolution: "done" | "cancelled" | "declined" | "expired" = "done") {
    await this.scans.get(id)?.catch(() => undefined);
    const r = await this.get(id);
    if (r.finding) this.suppressed.set(id, `${r.finding.kind}:${r.origin}`);
    r.status = resolution === "done" ? "resolved" : "paused";
    r.resolution = resolution;
    r.at = now();
    await this.d.store.write(`identity/friction/${id}.json`, r);
  }
  scan(id: string): Promise<FrictionRecord> {
    const existing = this.scans.get(id);
    if (existing) return existing;
    const task = this.scanNow(id);
    this.scans.set(id, task);
    void task
      .finally(() => {
        if (this.scans.get(id) === task) this.scans.delete(id);
      })
      .catch(() => undefined);
    return task;
  }
  private async scanNow(id: string): Promise<FrictionRecord> {
    dataSessionId(id);
    if (this.busy.has(id)) return this.get(id);
    this.busy.add(id);
    try {
      const session = this.d.getSession(id);
      const page = await activePage(session);
      if (!page) return { sessionId: id, at: now(), status: "unavailable", automaticRetry: false };
      const signals = await bounded(
        page.evaluate(() => {
          const visible = (el: Element | null) => !!el && !!(el as HTMLElement).offsetParent;
          const text = (document.body?.innerText ?? "").slice(0, 30_000).toLowerCase();
          const password = Array.from(document.querySelectorAll('input[type="password"]')).some(
            visible,
          );
          const code = Array.from(
            document.querySelectorAll('input[autocomplete="one-time-code"]'),
          ).some(visible);
          return {
            captcha:
              Array.from(
                document.querySelectorAll(
                  'iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare"],[class*="cf-turnstile"]',
                ),
              ).some(visible) ||
              (Array.from(document.querySelectorAll("h1,h2,[role=heading]")).some(
                (el) => visible(el) && /verify (that )?you are human/i.test(el.textContent ?? ""),
              ) &&
                !password),
            twoFactor:
              code ||
              (/(two.factor|verification code|authenticator code)/.test(text) &&
                Array.from(document.querySelectorAll('input[inputmode="numeric"]')).some(visible)),
            loginExpired:
              password &&
              /(session (has )?expired|sign in to continue|log in to continue)/.test(text),
          };
        }),
        3000,
      );
      const entry = this.attached.get(id)?.observations.get(page),
        last = entry?.last && entry.last.at > Date.now() - 60_000 ? entry.last : undefined;
      const finding = classifyFriction({
        ...signals,
        status: last?.status,
        retryAfter: last?.retryAfter,
        redirects: entry?.redirects.filter((t) => t > Date.now() - 15_000).length,
      });
      const origin = safeOrigin(page.url());
      const previous = await this.get(id);
      const record: FrictionRecord = {
        sessionId: id,
        at: now(),
        status: finding ? "waiting" : "clear",
        finding,
        origin,
        automaticRetry: false,
      };
      if (!finding) this.suppressed.delete(id);
      else if (
        this.suppressed.get(id) === `${finding.kind}:${origin}` ||
        (["resolved", "paused"].includes(previous.status) &&
          previous.finding?.kind === finding.kind &&
          previous.origin === origin)
      ) {
        record.status = previous.status === "paused" ? "paused" : "resolved";
        record.resolution = previous.resolution;
      } else if (this.d.handoffs.isWaiting(id)) {
        record.handoffId = this.d.handoffs.get(id)?.id;
      } else {
        const handoff = await this.d.handoffs.create(
          id,
          {
            reason: finding.reason,
            instructions: finding.retryAfterMs
              ? `Wait at least ${Math.ceil(
                  finding.retryAfterMs / 1000,
                )} seconds before considering a retry. Review the page, then explicitly resume the task.`
              : "Review and resolve the page prompt, then mark the handoff done. No automatic retries will run.",
            notify: true,
          },
          "friction-observer",
        );
        record.handoffId = handoff.id;
        this.d.publish("friction.detected", { ...finding, pause: true, handoffId: handoff.id }, id);
      }
      await this.d.store.write(`identity/friction/${id}.json`, record);
      if (previous.status !== record.status) this.d.publish("friction.changed", record, id);
      return record;
    } finally {
      this.busy.delete(id);
    }
  }
  async close() {
    clearInterval(this.timer);
    await Promise.allSettled([...this.scans.values()]);
    for (const id of this.attached.keys()) this.detach(id);
  }
}
