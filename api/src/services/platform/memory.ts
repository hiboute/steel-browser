import { readFileSync, readdirSync } from "node:fs";
import os from "node:os";

export interface MemorySnapshot {
  totalBytes: number;
  availableBytes: number;
  limitBytes: number | null;
  chromeRssBytes: number;
  minFreeBytes: number;
  pressure: boolean;
}
interface ProcessMemory {
  pid: number;
  parent: number;
  rssBytes: number;
}

const numericFile = (path: string): number | undefined => {
  try {
    const raw = readFileSync(path, "utf8").trim();
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
};

/** Container-aware admission checks. Unknown host data fails closed when a guard is configured. */
export class MemoryGuard {
  private cached?: { at: number; value: MemorySnapshot; processes: ProcessMemory[] };
  constructor(
    readonly minFreeBytes = 0,
    private procRoot = "/proc",
    private cgroupRoot = "/sys/fs/cgroup",
  ) {}

  private refresh(): void {
    if (this.cached && Date.now() - this.cached.at < 1000) return;
    let total = os.totalmem();
    let available = os.freemem();
    try {
      const raw = readFileSync(`${this.procRoot}/meminfo`, "utf8");
      const field = (name: string) =>
        Number(new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(raw)?.[1] ?? NaN) * 1024;
      const hostTotal = field("MemTotal");
      const hostAvailable = field("MemAvailable");
      if (Number.isFinite(hostTotal)) total = hostTotal;
      if (Number.isFinite(hostAvailable)) available = hostAvailable;
    } catch {
      /* os memory is the portable fallback. */
    }
    let limit = numericFile(`${this.cgroupRoot}/memory.max`);
    let used = numericFile(`${this.cgroupRoot}/memory.current`);
    if (limit === undefined) {
      limit = numericFile(`${this.cgroupRoot}/memory/memory.limit_in_bytes`);
      used = numericFile(`${this.cgroupRoot}/memory/memory.usage_in_bytes`);
    }
    // v1's huge sentinel means unlimited. A finite container limit cannot exceed host RAM.
    const effectiveLimit = limit !== undefined && limit <= total ? limit : undefined;
    if (effectiveLimit !== undefined)
      available = Math.min(available, used === undefined ? 0 : Math.max(0, effectiveLimit - used));
    const processes: ProcessMemory[] = [];
    try {
      for (const name of readdirSync(this.procRoot)) {
        if (!/^\d+$/.test(name)) continue;
        try {
          const raw = readFileSync(`${this.procRoot}/${name}/status`, "utf8");
          processes.push({
            pid: Number(name),
            parent: Number(/^PPid:\s+(\d+)/m.exec(raw)?.[1] ?? 0),
            rssBytes: Number(/^VmRSS:\s+(\d+)/m.exec(raw)?.[1] ?? 0) * 1024,
          });
        } catch {
          /* Processes may exit between directory enumeration and read. */
        }
      }
    } catch {
      /* No /proc outside Linux. */
    }
    this.cached = {
      at: Date.now(),
      processes,
      value: {
        totalBytes: total,
        availableBytes: available,
        limitBytes: effectiveLimit ?? null,
        chromeRssBytes: 0,
        minFreeBytes: this.minFreeBytes,
        pressure: this.minFreeBytes > 0 && available < this.minFreeBytes,
      },
    };
  }

  processTreeRss(pid: number): number {
    this.refresh();
    const descendants = new Set([pid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const process of this.cached!.processes) {
        if (descendants.has(process.parent) && !descendants.has(process.pid)) {
          descendants.add(process.pid);
          changed = true;
        }
      }
    }
    return this.cached!.processes.filter((process) => descendants.has(process.pid)).reduce(
      (sum, process) => sum + process.rssBytes,
      0,
    );
  }

  snapshot(pids: number[] = []): MemorySnapshot {
    this.refresh();
    return {
      ...this.cached!.value,
      chromeRssBytes: [...new Set(pids)].reduce((sum, pid) => sum + this.processTreeRss(pid), 0),
    };
  }
  hasCapacity(): boolean {
    return this.minFreeBytes === 0 || !this.snapshot().pressure;
  }
}
