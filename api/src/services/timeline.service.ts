import { isSensitiveSession, redactKnownSecrets } from "./data/privacy.js";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Session } from "./session.service.js";
import type { PlatformStore } from "./platform/store.js";
import type { BrowserEventUnion } from "./cdp/instrumentation/types.js";
import { BrowserEventType, EmitEvent } from "../types/enums.js";
import {
  activePage,
  AgentFeatureError,
  configuredNumber,
  dataSessionId,
  redactArguments,
  screenshot,
} from "./handoff/agent-feature-utils.js";

export interface TimelineInput {
  kind?: string;
  tool: string;
  args?: unknown;
  status?: string;
  error?: string;
  durationMs?: number;
  url?: string;
  title?: string;
  screenshot?: boolean;
}

export interface TimelineEntry extends Omit<TimelineInput, "kind" | "screenshot"> {
  seq: number;
  at: string;
  client: string;
  kind: string;
  screenshot: boolean;
}

interface TimelineDependencies {
  store: PlatformStore;
  getSession(id: string): Session | undefined;
  publish(type: string, data: unknown, sessionId?: string): unknown;
  log(error: unknown): void;
  maxEntries?: number;
  retentionDays?: number;
}

export class TimelineService {
  private readonly writes = new Map<string, Promise<unknown>>();
  private readonly detach = new Map<string, () => void>();
  private readonly maxEntries: number;
  private readonly retentionDays: number;

  constructor(private readonly deps: TimelineDependencies) {
    this.maxEntries = deps.maxEntries ?? 2_000;
    this.retentionDays = deps.retentionDays ?? configuredNumber("TIMELINE_RETENTION_DAYS", 7);
  }

  private file(id: string) {
    return `timeline/${dataSessionId(id)}/entries.jsonl`;
  }

  async read(id: string, after = 0, limit = 100): Promise<TimelineEntry[]> {
    await this.writes.get(id)?.catch(() => undefined);
    const entries = await this.deps.store.readLines<TimelineEntry>(this.file(id));
    return entries
      .filter((entry) => entry.seq > after)
      .slice(0, Math.min(2_000, Math.max(1, limit)));
  }

  append(id: string, input: TimelineInput, client = "system"): Promise<TimelineEntry> {
    const filename = this.file(id);
    const operation = (this.writes.get(id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const entries = await this.deps.store.readLines<TimelineEntry>(filename);
        const entry: TimelineEntry = {
          ...redactKnownSecrets(input),
          ...(isSensitiveSession(id)
            ? {
                url: undefined,
                title: undefined,
                error: input.error ? "[private capture]" : undefined,
              }
            : {}),
          args: isSensitiveSession(id)
            ? { redacted: true }
            : redactKnownSecrets(redactArguments(input.args)),
          seq: (entries.at(-1)?.seq ?? 0) + 1,
          at: new Date().toISOString(),
          client,
          kind: input.kind ?? "action",
          screenshot: false,
        };
        if (input.screenshot && !isSensitiveSession(id)) {
          const session = this.deps.getSession(id);
          if (session?.status === "live" && !session.isSelenium) {
            try {
              const page = await activePage(session);
              if (page) {
                const image = await screenshot(page);
                const target = this.deps.store.path(`timeline/${id}/${entry.seq}.jpg`);
                await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
                await writeFile(target, image, { mode: 0o600 });
                entry.screenshot = true;
                entry.url ??= page.url();
                entry.title ??= await page.title();
              }
            } catch (error) {
              this.deps.log(error);
            }
          }
        }
        entries.push(entry);
        const removed = entries.splice(0, Math.max(0, entries.length - this.maxEntries));
        if (removed.length) await this.deps.store.rewriteLines(filename, entries);
        else await this.deps.store.append(filename, entry);
        await Promise.all(
          removed
            .filter((old) => old.screenshot)
            .map((old) =>
              rm(this.deps.store.path(`timeline/${id}/${old.seq}.jpg`), { force: true }),
            ),
        );
        this.deps.publish("timeline.entry", entry, id);
        return entry;
      });
    this.writes.set(id, operation);
    void operation
      .finally(() => {
        if (this.writes.get(id) === operation) this.writes.delete(id);
      })
      .catch(() => undefined);
    return operation;
  }

  async image(id: string, seq: number): Promise<Buffer> {
    const entries = await this.read(id, seq - 1, 1);
    if (!entries.some((entry) => entry.seq === seq && entry.screenshot)) {
      throw new AgentFeatureError(404, "screenshot_not_found", "Timeline screenshot not found");
    }
    try {
      return await readFile(this.deps.store.path(`timeline/${dataSessionId(id)}/${seq}.jpg`));
    } catch {
      throw new AgentFeatureError(404, "screenshot_not_found", "Timeline screenshot not found");
    }
  }

  attach(session: Session) {
    this.detachSession(session.id);
    const logger = session.cdpService.getInstrumentationLogger();
    const listener = (event: BrowserEventUnion) => {
      if (
        event.type !== BrowserEventType.Navigation ||
        (event.targetType && event.targetType !== "page")
      )
        return;
      void this.append(session.id, {
        kind: "navigation",
        tool: "Page.navigate",
        url: event.navigation.url,
        status: "done",
      }).catch(this.deps.log);
    };
    logger.on?.(EmitEvent.Log, listener);
    this.detach.set(session.id, () => logger.off?.(EmitEvent.Log, listener));
  }

  detachSession(id: string) {
    this.detach.get(id)?.();
    this.detach.delete(id);
  }

  async sweep() {
    const cutoff = Date.now() - this.retentionDays * 86_400_000;
    for (const id of await this.deps.store.list("timeline")) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || this.deps.getSession(id) || this.writes.has(id))
        continue;
      const entries = await this.deps.store.readLines<TimelineEntry>(this.file(id));
      if (!entries.length || Date.parse(entries.at(-1)!.at) < cutoff)
        await this.deps.store.remove(`timeline/${id}`);
    }
  }

  async close() {
    for (const id of this.detach.keys()) this.detachSession(id);
    await Promise.allSettled(this.writes.values());
  }
}
