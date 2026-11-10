import { randomUUID } from "node:crypto";
import { PlatformStore } from "./store.js";

export interface AuditEntry {
  id: string;
  at: string;
  event: string;
  client: string;
  subject?: string;
  sessionId?: string;
  detail?: unknown;
}

export class AuditLog {
  constructor(
    private store: PlatformStore,
    private retentionDays = 180,
  ) {}
  async log(
    event: string,
    input: Omit<AuditEntry, "id" | "at" | "event" | "client"> & { client?: string } = {},
  ): Promise<AuditEntry> {
    const entry = {
      ...input,
      id: randomUUID(),
      at: new Date().toISOString(),
      event,
      client: input.client ?? "anonymous",
    };
    await this.store.append(`audit/${entry.at.slice(0, 7)}.jsonl`, entry);
    return entry;
  }
  async list(
    query: { limit?: number; before?: string; event?: string; subject?: string } = {},
  ): Promise<AuditEntry[]> {
    const limit = Math.max(1, Math.min(1000, query.limit ?? 100));
    const cutoff = Date.now() - this.retentionDays * 86_400_000;
    const result: AuditEntry[] = [];
    for (const file of (await this.store.list("audit"))
      .filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name))
      .sort()
      .reverse()) {
      const entries = await this.store.readLines<AuditEntry>(`audit/${file}`);
      for (const entry of entries.reverse()) {
        if (
          Date.parse(entry.at) < cutoff ||
          (query.before && entry.at >= query.before) ||
          (query.event && entry.event !== query.event) ||
          (query.subject && entry.subject !== query.subject)
        )
          continue;
        result.push(entry);
        if (result.length >= limit) return result;
      }
    }
    return result;
  }
  async sweep(now = Date.now()): Promise<void> {
    const cutoff = new Date(now - this.retentionDays * 86_400_000).toISOString();
    for (const file of (await this.store.list("audit")).filter((name) =>
      /^\d{4}-\d{2}\.jsonl$/.test(name),
    )) {
      const month = file.slice(0, 7);
      if (month < cutoff.slice(0, 7)) await this.store.remove(`audit/${file}`);
      else if (month === cutoff.slice(0, 7))
        await this.store.updateLines<AuditEntry>(`audit/${file}`, (entries) =>
          entries.filter((entry) => entry.at >= cutoff),
        );
    }
  }
}
