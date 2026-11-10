import { lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { PlatformStore } from "../platform/store.js";

export interface StorageKind {
  key: string;
  label: string;
  bytes: number;
  items: number;
  /** How this kind is kept, in words a person can act on. */
  retention: string;
}
export interface StorageReport {
  at: string;
  totalBytes: number;
  kinds: StorageKind[];
  lastPrune?: PruneResult;
}
export interface PruneResult {
  at: string;
  removed: Record<string, number>;
}
export interface StorageDeps {
  store: PlatformStore;
  /** Directories outside the data root that also grow, by kind key. */
  external?: Record<string, { label: string; path: string; retention: string }>;
  /** Session ids whose data must stay: live and parked browsers. */
  activeIds: () => Set<string>;
  /** Sweeps owned by other services, run as part of a prune. */
  sweeps?: Record<string, () => Promise<number | void>>;
  env?: Record<string, string | undefined>;
}

const days = (env: Record<string, string | undefined>, name: string, fallback: number) => {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

async function measure(target: string): Promise<{ bytes: number; items: number }> {
  let info;
  try {
    info = await lstat(target);
  } catch {
    return { bytes: 0, items: 0 };
  }
  if (!info.isDirectory()) return { bytes: info.size, items: 1 };
  let bytes = 0,
    items = 0;
  for (const name of await readdir(target).catch(() => [] as string[])) {
    const child = await measure(path.join(target, name));
    bytes += child.bytes;
    items += child.items;
  }
  return { bytes, items };
}

/** One view of everything Steel keeps on disk, and one place to prune it. */
export class StorageService {
  private readonly env: Record<string, string | undefined>;
  private last?: PruneResult;
  constructor(private readonly deps: StorageDeps) {
    this.env = deps.env ?? process.env;
  }

  /** Days kept for the kinds this service prunes itself. */
  get diagnosticsDays() {
    return days(this.env, "DIAGNOSTICS_RETENTION_DAYS", 30);
  }
  get controlDays() {
    return days(this.env, "CONTROL_RECORD_RETENTION_DAYS", 30);
  }

  private retention(key: string): [string, string] {
    const e = this.env;
    const known: Record<string, [string, string]> = {
      timeline: [
        "Action timelines",
        `${days(e, "TIMELINE_RETENTION_DAYS", 7)} days after the last action`,
      ],
      recordings: [
        "Recordings",
        `${days(e, "RECORDING_RETENTION_DAYS", 7)} days, ${days(
          e,
          "RECORDING_TOTAL_MAX_MB",
          4000,
        )} MB in total`,
      ],
      files: [
        "Session files",
        `${days(e, "FILES_RETENTION_HOURS", 72)} hours after the browser is released`,
      ],
      audit: ["Audit log", `${days(e, "AUDIT_RETENTION_DAYS", 180)} days`],
      parked: [
        "Parked browsers",
        `${Math.round(days(e, "PARKED_TTL_MS", 604_800_000) / 86_400_000)} days without use`,
      ],
      checkpoints: ["Checkpoints", "Each checkpoint's own expiry (30 days by default)"],
      diagnostics: ["Doctor reports", `${this.diagnosticsDays} days`],
      "egress-diagnostics": ["Egress reports", `${this.diagnosticsDays} days`],
      control: ["Ownership records", `${this.controlDays} days after the browser is gone`],
      identity: ["Identity profiles and reports", "Profiles kept; newest 1,000 reports"],
      workflows: ["Procedures and receipts", "Kept until deleted"],
      runs: ["Task runs", "Kept until deleted"],
      watchers: ["Page watches", "Kept until deleted"],
      data: ["Extraction and search data", "Kept until deleted"],
    };
    return known[key] ?? [key, "Kept until deleted"];
  }

  async report(): Promise<StorageReport> {
    const root = this.deps.store.root;
    const kinds: StorageKind[] = [];
    for (const name of (await readdir(root).catch(() => [] as string[])).sort()) {
      if (name.startsWith(".")) continue;
      const key = name.replace(/\.(jsonl?|tmp)$/, "");
      const [label, retention] = this.retention(key);
      const size = await measure(path.join(root, name));
      const existing = kinds.find((kind) => kind.key === key);
      if (existing) {
        existing.bytes += size.bytes;
        existing.items += size.items;
      } else kinds.push({ key, label, retention, ...size });
    }
    for (const [key, extra] of Object.entries(this.deps.external ?? {})) {
      if (path.resolve(extra.path).startsWith(root + path.sep)) continue;
      if (!(await stat(extra.path).catch(() => undefined))) continue;
      kinds.push({
        key,
        label: extra.label,
        retention: extra.retention,
        ...(await measure(extra.path)),
      });
    }
    kinds.sort((a, b) => b.bytes - a.bytes);
    return {
      at: new Date().toISOString(),
      totalBytes: kinds.reduce((sum, kind) => sum + kind.bytes, 0),
      kinds,
      lastPrune: this.last,
    };
  }

  /** Removes entries of `dir` older than `maxDays` that belong to no active browser. */
  private async pruneOlder(dir: string, maxDays: number) {
    const cutoff = Date.now() - maxDays * 86_400_000;
    const active = this.deps.activeIds();
    let removed = 0;
    for (const name of await this.deps.store.list(dir)) {
      if (active.has(name.replace(/\.json$/, ""))) continue;
      const info = await stat(this.deps.store.path(`${dir}/${name}`)).catch(() => undefined);
      if (!info || info.mtimeMs > cutoff) continue;
      await this.deps.store.remove(`${dir}/${name}`);
      removed++;
    }
    return removed;
  }

  async prune(): Promise<PruneResult> {
    const removed: Record<string, number> = {};
    for (const dir of ["diagnostics", "egress-diagnostics"])
      removed[dir] = await this.pruneOlder(dir, this.diagnosticsDays);
    for (const [key, sweep] of Object.entries(this.deps.sweeps ?? {})) {
      try {
        removed[key] = (await sweep()) ?? 0;
      } catch {
        removed[key] = -1;
      }
    }
    this.last = { at: new Date().toISOString(), removed };
    return this.last;
  }
}
