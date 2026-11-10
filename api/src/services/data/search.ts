import { isSensitiveSession } from "./privacy.js";
import { createHash } from "node:crypto";
import { DataError, DataRecords, sanitized, type DataActor, type DataRecord } from "./common.js";

export interface SearchDocument extends DataRecord {
  sourceId: string;
  title: string;
  text: string;
  href: string;
  sourceKind: string;
}
export class SessionSearch {
  private sourceCheckers = new Map<
    string,
    (record: SearchDocument, actor: DataActor) => Promise<boolean>
  >();
  registerSource(
    kind: string,
    check: (record: SearchDocument, actor: DataActor) => Promise<boolean>,
  ) {
    this.sourceCheckers.set(kind, check);
    return () => {
      this.sourceCheckers.delete(kind);
    };
  }
  constructor(
    private records: DataRecords,
    private sourceExists: (record: SearchDocument, actor: DataActor) => Promise<boolean>,
  ) {}
  async index(input: {
    sourceId: string;
    owner: string;
    sessionId?: string;
    title: string;
    text: string;
    href: string;
    kind: string;
    expiresAt?: string;
  }) {
    if (input.sessionId && isSensitiveSession(input.sessionId)) {
      await this.remove(input.kind, input.sourceId);
      return;
    }
    const id = createHash("sha256").update(`${input.kind}:${input.sourceId}`).digest("hex");
    const now = new Date().toISOString();
    const clean = sanitized({ title: input.title, text: input.text }) as {
      title: string;
      text: string;
    };
    // Only local application links can be emitted by search; no arbitrary clickable result URLs.
    const href =
      input.href.startsWith("/") && !input.href.startsWith("//") ? input.href : "/sessions";
    await this.records.store.write(`data/search/${id}.json`, {
      id,
      kind: "search",
      sourceKind: input.kind,
      sourceId: input.sourceId,
      owner: input.owner,
      sessionId: input.sessionId,
      title: clean.title.slice(0, 200),
      text: clean.text.slice(0, 100_000),
      href,
      createdAt: now,
      expiresAt: input.expiresAt || new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
  }
  async remove(kind: string, sourceId: string) {
    const id = createHash("sha256").update(`${kind}:${sourceId}`).digest("hex");
    await this.records.store.remove(`data/search/${id}.json`);
  }
  async search(
    actor: DataActor,
    query: { q: string; sessionId?: string; kind?: string; limit?: number; cursor?: number },
  ) {
    const terms = query.q
      .normalize("NFKC")
      .toLocaleLowerCase()
      .trim()
      .split(/\s+/u)
      .filter(Boolean);
    if (!terms.length || query.q.length > 500 || terms.length > 20)
      throw new DataError("invalid_query", "Search needs 1–20 terms and at most 500 characters");
    const limit = Math.max(1, Math.min(query.limit ?? 20, 100));
    const offset = query.cursor ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10_000)
      throw new DataError("invalid_cursor", "Invalid search cursor");
    const matches: {
      id: string;
      sourceId: string;
      kind: string;
      sessionId?: string;
      title: string;
      snippet: string;
      href: string;
      observedAt: string;
    }[] = [];
    const deadline = Date.now() + 5000;
    let truncated = false;
    for await (const document of this.records.iterate<SearchDocument>("search", actor)) {
      // Apply to every source kind, including checkers registered by other plugins.
      if (document.sessionId && isSensitiveSession(document.sessionId)) continue;
      if (Date.now() > deadline) {
        truncated = true;
        break;
      }
      if (
        (query.sessionId && document.sessionId !== query.sessionId) ||
        (query.kind && document.sourceKind !== query.kind)
      )
        continue;
      const text = `${document.title}\n${document.text}`;
      const normalized = text.normalize("NFKC").toLocaleLowerCase();
      if (!terms.every((term) => normalized.includes(term))) continue;
      if (
        !(await (this.sourceCheckers.get(document.sourceKind) || this.sourceExists)(
          document,
          actor,
        ))
      )
        continue;
      if (document.sessionId && isSensitiveSession(document.sessionId)) continue;

      const start = Math.max(0, normalized.indexOf(terms[0]) - 80);
      matches.push({
        id: document.id,
        sourceId: document.sourceId,
        kind: document.sourceKind,
        sessionId: document.sessionId,
        title: document.title,
        snippet: text.slice(start, start + 300),
        href: document.href,
        observedAt: document.createdAt,
      });
    }
    return {
      results: matches.slice(offset, offset + limit),
      total: matches.length,
      truncated,
      nextCursor: matches.length > offset + limit ? offset + limit : null,
    };
  }
}
