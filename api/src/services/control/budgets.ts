import type { CDPSession, Target } from "puppeteer-core";
import type { PlatformStore } from "../platform/store.js";
import type { Session, StartSessionOptions } from "../session.service.js";
import { AccessError } from "./access.js";
export interface BudgetConfig {
  clients: Record<string, { maxConcurrent: number; weight: number }>;
  sites: Record<string, { maxConcurrent: number }>;
  defaultMaxConcurrent: number;
}
export class BudgetService {
  private config: BudgetConfig = { clients: {}, sites: {}, defaultMaxConcurrent: 1000 };
  private requests = new Map<
    string,
    { principal: string; authenticated: boolean; site?: string }
  >();
  private active = new Set<string>();
  private sites = new Map<string, Set<string>>();
  private cleanup = new Map<string, () => Promise<void>>();
  constructor(
    private store: PlatformStore,
    private authenticated: boolean,
  ) {}
  async initialize() {
    const config = await this.store.read<BudgetConfig>("budgets.json");
    if (config) this.config = this.validate(config);
  }
  private validate(value: BudgetConfig) {
    if (
      !this.authenticated &&
      (Object.keys(value.clients ?? {}).length || value.defaultMaxConcurrent < 1000)
    )
      throw new AccessError(
        "trusted_identity_required",
        "Configure verified authentication before client budgets",
        409,
      );
    const limit = (n: number) => Number.isInteger(n) && n >= 1 && n <= 10000;
    if (!limit(value.defaultMaxConcurrent) || !value.clients || !value.sites)
      throw new AccessError("invalid_budget", "Invalid budget configuration", 400);
    for (const c of Object.values(value.clients))
      if (!limit(c.maxConcurrent) || !Number.isInteger(c.weight) || c.weight < 1 || c.weight > 100)
        throw new AccessError("invalid_budget", "Client limits and weights are out of range", 400);
    for (const [site, c] of Object.entries(value.sites))
      if (new URL(site).origin !== site || !/^https?:/.test(site) || !limit(c.maxConcurrent))
        throw new AccessError(
          "invalid_budget",
          "Site budgets require an exact HTTP(S) origin and positive limit",
          400,
        );
    return structuredClone(value);
  }
  async configure(config: BudgetConfig) {
    if (this.active.size)
      throw new AccessError(
        "browsers_active",
        "Park all browsers before changing budget policy",
        409,
      );
    this.config = this.validate(config);
    await this.store.write("budgets.json", this.config);
    return this.get();
  }
  get() {
    return {
      config: structuredClone(this.config),
      active: [...this.active].map((id) => ({ sessionId: id, ...this.requests.get(id) })),
      sites: Object.fromEntries([...this.sites].map(([site, ids]) => [site, ids.size])),
    };
  }
  register(options: StartSessionOptions) {
    this.requests.set(options.sessionId!, {
      principal: options._principal?.id ?? "system",
      authenticated: options._principal?.authenticated ?? false,
      site: options.siteScope ? new URL(options.siteScope).origin : undefined,
    });
  }
  metadata(id: string) {
    const r = this.requests.get(id);
    return {
      principal: r?.principal ?? "system",
      weight: this.config.clients[r?.principal ?? "system"]?.weight ?? 1,
    };
  }
  reason(id: string) {
    const r = this.requests.get(id);
    if (!r) return undefined;
    const budget = this.config.clients[r.principal];
    const count = [...this.active].filter(
      (other) => this.requests.get(other)?.principal === r.principal,
    ).length;
    if (count >= (budget?.maxConcurrent ?? this.config.defaultMaxConcurrent))
      return "client_budget";
    if (
      r.site &&
      this.config.sites[r.site] &&
      (this.sites.get(r.site)?.size ?? 0) >= this.config.sites[r.site].maxConcurrent
    )
      return "site_budget";
    return undefined;
  }
  canAcquire(id: string) {
    return !this.reason(id);
  }
  acquired(id: string) {
    this.active.add(id);
    const site = this.requests.get(id)?.site;
    if (site) this.claimSite(id, site);
  }
  release(id: string) {
    this.active.delete(id);
    for (const ids of this.sites.values()) ids.delete(id);
    // Admission registers the request again on every start and resume.
    this.requests.delete(id);
  }
  claimSite(id: string, url: string) {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return true;
    }
    const budget = this.config.sites[origin];
    if (!budget) return true;
    const ids = this.sites.get(origin) ?? new Set<string>();
    this.sites.set(origin, ids);
    if (ids.has(id)) return true;
    if (ids.size >= budget.maxConcurrent) return false;
    ids.add(id);
    return true;
  }
  async attach(session: Session) {
    await this.detach(session.id);
    if (!Object.keys(this.config.sites).length || session.isSelenium) return;
    const browser = session.cdpService.getBrowserInstance();
    if (!browser) return;
    const clients = new Set<CDPSession>();
    let closed = false;
    const attach = async (target: Target) => {
      if (target.type() === "browser") return;
      let client: CDPSession | undefined;
      try {
        client = await target.createCDPSession();
        if (closed) {
          await client.detach();
          return;
        }
        clients.add(client);
        const c = client;
        c.on("Fetch.requestPaused", (event) => {
          const allowed = this.claimSite(session.id, event.request.url);
          void c
            .send(
              allowed ? "Fetch.continueRequest" : "Fetch.failRequest",
              allowed
                ? { requestId: event.requestId }
                : { requestId: event.requestId, errorReason: "BlockedByClient" },
            )
            .catch(() => {});
        });
        await c.send("Fetch.enable", {
          patterns: Object.keys(this.config.sites).map((origin) => ({
            urlPattern: `${origin}/*`,
            requestStage: "Request" as const,
          })),
        });
      } catch {
        if (client) {
          clients.delete(client);
          await client.detach().catch(() => {});
        }
        if (target.type() === "page")
          throw new AccessError(
            "site_budget_guard_failed",
            "Cannot enforce site network budget",
            503,
          );
      }
    };
    const listener = (target: Target) => {
      void attach(target).catch(() => session.cdpService.getBrowserInstance()?.close());
    };
    browser.on("targetcreated", listener);
    this.cleanup.set(session.id, async () => {
      closed = true;
      browser.off("targetcreated", listener);
      await Promise.allSettled([...clients].map((c) => c.detach()));
    });
    await Promise.all(browser.targets().map(attach));
  }
  async detach(id: string) {
    await this.cleanup.get(id)?.();
    this.cleanup.delete(id);
  }
  async close() {
    await Promise.all([...this.cleanup.keys()].map((id) => this.detach(id)));
  }
}
