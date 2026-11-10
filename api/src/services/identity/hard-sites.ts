import type { PlatformStore } from "../platform/store.js";
import type { FrictionFinding } from "./friction.service.js";

/** Friction that means the site did not accept the browser, as opposed to asking its user something. */
export const BLOCKING: FrictionFinding["kind"][] = ["captcha", "access_denied"];
const FILE = "identity/hard-sites.json";
const DAY = 86_400_000;

export interface HardSite {
  origin: string;
  hits: number;
  kinds: Partial<Record<FrictionFinding["kind"], number>>;
  firstAt: string;
  lastAt: string;
}
export interface DesktopWorker {
  id: string;
  label: string;
  location: string;
  engines: string[];
}
export interface HardSiteAdvice {
  origin: string;
  hard: boolean;
  hits: number;
  lastAt?: string;
  /** A paired real desktop that is online and has room, when there is one. */
  desktop?: DesktopWorker;
  suggestion?: string;
}
type Worker = {
  id: string;
  label: string;
  location: string;
  healthy: boolean;
  draining: boolean;
  activeSessions: number;
  capabilities: {
    engines: string[];
    commands: string[];
    capacity: number;
    device: { kind: string; graphics: string; headless: boolean };
  };
};

/** A real desktop: its own screen and GPU, and free to take a browser now. */
export function desktopWorker(workers: Worker[]): DesktopWorker | undefined {
  const worker = workers
    .filter(
      (w) =>
        w.healthy &&
        !w.draining &&
        w.capabilities.device.kind === "desktop" &&
        w.capabilities.device.graphics === "native" &&
        !w.capabilities.device.headless &&
        w.capabilities.commands.includes("launch") &&
        w.activeSessions < w.capabilities.capacity,
    )
    .sort((a, b) => a.activeSessions - b.activeSessions)[0];
  return (
    worker && {
      id: worker.id,
      label: worker.label,
      location: worker.location,
      engines: worker.capabilities.engines,
    }
  );
}

/** Remembers the sites that keep stopping Steel's own browsers. */
export class HardSites {
  private sites?: Map<string, HardSite>;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly d: {
      store: PlatformStore;
      workers?: () => Worker[];
      now?: () => number;
      /** Blocks within the window before a site counts as hard. */
      threshold?: number;
      days?: number;
    },
  ) {}
  private now() {
    return this.d.now?.() ?? Date.now();
  }
  private get threshold() {
    return this.d.threshold ?? 2;
  }
  private async load() {
    if (!this.sites) {
      const saved = (await this.d.store.read<{ sites: HardSite[] }>(FILE))?.sites ?? [];
      this.sites = new Map(saved.map((s) => [s.origin, s]));
    }
    const cutoff = this.now() - (this.d.days ?? 30) * DAY;
    for (const [origin, site] of this.sites)
      if (Date.parse(site.lastAt) < cutoff) this.sites.delete(origin);
    return this.sites;
  }
  private save(sites: Map<string, HardSite>) {
    const list = [...sites.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, 500);
    return this.d.store.write(FILE, { sites: list });
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const run = this.pending.catch(() => undefined).then(action);
    this.pending = run;
    return run;
  }

  record(origin: string, kind: FrictionFinding["kind"]) {
    if (!BLOCKING.includes(kind) || !/^https?:\/\//.test(origin)) return Promise.resolve();
    return this.serial(async () => {
      const sites = await this.load(),
        at = new Date(this.now()).toISOString();
      const site = sites.get(origin) ?? { origin, hits: 0, kinds: {}, firstAt: at, lastAt: at };
      site.hits++;
      site.kinds[kind] = (site.kinds[kind] ?? 0) + 1;
      site.lastAt = at;
      sites.set(origin, site);
      await this.save(sites);
    });
  }
  async list(): Promise<(HardSite & { hard: boolean })[]> {
    return [...(await this.load()).values()]
      .map((s) => ({ ...s, hard: s.hits >= this.threshold }))
      .sort((a, b) => b.hits - a.hits);
  }
  forget(origin: string) {
    return this.serial(async () => {
      const sites = await this.load(),
        removed = sites.delete(origin);
      if (removed) await this.save(sites);
      return removed;
    });
  }
  async advice(url: string): Promise<HardSiteAdvice> {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return { origin: "unavailable", hard: false, hits: 0 };
    }
    const site = (await this.load()).get(origin);
    const hits = site?.hits ?? 0,
      hard = hits >= this.threshold;
    if (!hard) return { origin, hard, hits, lastAt: site?.lastAt };
    const desktop = desktopWorker(this.d.workers?.() ?? []);
    return {
      origin,
      hard,
      hits,
      lastAt: site?.lastAt,
      desktop,
      suggestion: desktop
        ? `This site stopped Steel's own browsers ${hits} times. The real desktop "${desktop.label}" is online: open it there with a fleet session on worker ${desktop.id}.`
        : `This site stopped Steel's own browsers ${hits} times and no real desktop worker is online. Expect a check that needs a person, or bring a desktop worker online.`,
    };
  }
}
