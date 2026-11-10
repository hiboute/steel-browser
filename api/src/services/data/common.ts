import { randomUUID } from "node:crypto";
import type { PlatformStore } from "../platform/store.js";
import { redactArguments } from "../handoff/agent-feature-utils.js";

import { redactKnownSecrets } from "./privacy.js";

export interface DataActor {
  id: string;
  role: "operator" | "agent";
  authenticated: boolean;
}
export class DataError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 400,
  ) {
    super(message);
  }
}
export function assertOwner(actor: DataActor, owner: string) {
  if (actor.role !== "operator" && actor.id !== owner)
    throw new DataError("not_found", "Resource not found", 404);
}
export function safeId(id: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new DataError("invalid_id", "Invalid resource ID");
  return id;
}
export function sanitized(value: unknown): unknown {
  const scrub = (input: unknown): unknown => {
    if (typeof input === "string")
      return input
        .replace(/\b(?:Bearer|Basic)\s+\S+/gi, "[redacted]")
        .replace(/((?:password|token|secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]");
    if (Array.isArray(input)) return input.map(scrub);
    if (input && typeof input === "object")
      return Object.fromEntries(Object.entries(input).map(([key, child]) => [key, scrub(child)]));
    return input;
  };
  return redactKnownSecrets(scrub(redactArguments(value)));
}
export interface DataRecord {
  id: string;
  owner: string;
  sessionId?: string;
  kind: string;
  createdAt: string;
  expiresAt: string;
}
export class DataRecords {
  constructor(
    readonly store: PlatformStore,
    private retentionDays = 30,
    private authorizeSession: (actor: DataActor, sessionId: string) => void = () => {},
  ) {}
  async create<T extends object>(
    kind: string,
    owner: string,
    data: T,
    sessionId?: string,
  ): Promise<T & DataRecord> {
    const now = Date.now();
    const record = {
      ...data,
      id: randomUUID(),
      owner,
      kind,
      sessionId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.retentionDays * 86_400_000).toISOString(),
    };
    await this.store.write(`data/${safeId(kind)}/${record.id}.json`, record);
    return record;
  }
  async get<T extends DataRecord>(kind: string, id: string, actor: DataActor): Promise<T> {
    const record = await this.store.read<T>(`data/${safeId(kind)}/${safeId(id)}.json`);
    if (!record || Date.parse(record.expiresAt) <= Date.now())
      throw new DataError("not_found", "Resource not found", 404);
    assertOwner(actor, record.owner);
    if (record.sessionId) this.authorizeSession(actor, record.sessionId);
    return record;
  }
  async remove(kind: string, id: string, actor: DataActor) {
    await this.get(kind, id, actor);
    await this.store.remove(`data/${safeId(kind)}/${safeId(id)}.json`);
  }
  async *iterate<T extends DataRecord>(kind: string, actor: DataActor): AsyncGenerator<T> {
    for (const file of (await this.store.list(`data/${safeId(kind)}`)).sort().slice(0, 10_000)) {
      if (!/^[A-Za-z0-9_-]+\.json$/.test(file)) continue;
      const value = await this.store.read<T>(`data/${kind}/${file}`);
      if (!value) continue;
      if (Date.parse(value.expiresAt) <= Date.now()) {
        await this.store.remove(`data/${kind}/${file}`);
        continue;
      }
      if (actor.role === "operator" || actor.id === value.owner) {
        try {
          if (value.sessionId) this.authorizeSession(actor, value.sessionId);
          yield value;
        } catch {}
      }
    }
  }
  async list<T extends DataRecord>(kind: string, actor: DataActor): Promise<T[]> {
    const result: T[] = [];
    let bytes = 0;
    for await (const value of this.iterate<T>(kind, actor)) {
      bytes += Buffer.byteLength(JSON.stringify(value));
      if (result.length >= 200 || bytes > 16 * 1024 * 1024) break;
      result.push(value);
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
