import { randomUUID } from "node:crypto";
import type { Session } from "./session.service.js";
import type { PlatformStore } from "./platform/store.js";
import {
  activePage,
  AgentFeatureError,
  bounded,
  dataSessionId,
} from "./handoff/agent-feature-utils.js";

export interface HandoffRequest {
  reason: string;
  instructions?: string;
  doneWhen?: {
    urlMatches?: string;
    urlNotMatches?: string;
    selector?: string;
    selectorGone?: string;
  };
  timeoutMs?: number;
  notify?: boolean;
}

export interface Handoff {
  id: string;
  sessionId: string;
  status: "waiting" | "done" | "declined" | "cancelled" | "expired";
  reason: string;
  instructions?: string;
  doneWhen?: HandoffRequest["doneWhen"];
  requestedBy: string;
  requestedAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  note: string | null;
  liveUrl: string;
}

interface HandoffDependencies {
  store: PlatformStore;
  getSession(id: string): Session | undefined;
  publish(type: string, data: unknown, sessionId?: string): unknown;
  notify(handoff: Handoff): Promise<unknown>;
  changed(handoff: Handoff): Promise<unknown>;
  log(error: unknown): void;
  viewerUrl: string;
}

export class HandoffService {
  private readonly handoffs = new Map<string, Handoff>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly changes = new Map<string, Promise<unknown>>();
  private timer?: NodeJS.Timeout;
  private polling = false;

  constructor(private readonly deps: HandoffDependencies) {}

  async initialize() {
    for (const file of await this.deps.store.list("handoffs")) {
      if (!file.endsWith(".json")) continue;
      const saved = await this.deps.store.read<Handoff>(`handoffs/${file}`);
      if (saved && saved.sessionId) {
        // A handoff is tied to a live browser and cannot survive a process restart.
        if (saved.status === "waiting") {
          saved.status = "cancelled";
          saved.resolvedAt = new Date().toISOString();
          saved.resolvedBy = "shutdown";
          saved.note = "The browser service restarted";
          await this.deps.store.write(`handoffs/${dataSessionId(saved.sessionId)}.json`, saved);
        }
        this.handoffs.set(saved.sessionId, saved);
      }
    }
    this.timer = setInterval(() => void this.poll().catch(this.deps.log), 2_000);
    this.timer.unref();
  }

  isWaiting(id: string): boolean {
    return this.handoffs.get(id)?.status === "waiting";
  }

  get(id: string): Handoff | undefined {
    return this.handoffs.get(id);
  }

  list(status?: Handoff["status"]): Handoff[] {
    return [...this.handoffs.values()]
      .filter((handoff) => !status || handoff.status === status)
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  }

  private serialize<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.changes.get(id) ?? Promise.resolve()).catch(() => undefined).then(fn);
    this.changes.set(id, next);
    void next
      .finally(() => {
        if (this.changes.get(id) === next) this.changes.delete(id);
      })
      .catch(() => undefined);
    return next;
  }

  create(id: string, input: HandoffRequest, client: string): Promise<Handoff> {
    dataSessionId(id);
    return this.serialize(id, async () => {
      const session = this.deps.getSession(id);
      if (!session || session.status !== "live") {
        throw new AgentFeatureError(409, "not_live", "Human handoff requires a live session");
      }
      if (session.isSelenium)
        throw new AgentFeatureError(409, "not_supported", "Human handoff requires a CDP session");
      if (this.isWaiting(id))
        throw new AgentFeatureError(
          409,
          "handoff_waiting",
          "This session is already waiting for a human",
        );
      const timeoutMs = input.timeoutMs ?? 900_000;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
        throw new AgentFeatureError(
          400,
          "invalid_timeout",
          "Handoff timeout must be 1 to 3600000 milliseconds",
        );
      }
      // Compile URL patterns before making the session exempt from idle expiry.
      for (const pattern of [input.doneWhen?.urlMatches, input.doneWhen?.urlNotMatches]) {
        if (pattern !== undefined) {
          try {
            new RegExp(pattern);
          } catch {
            throw new AgentFeatureError(400, "invalid_condition", "Invalid URL pattern");
          }
        }
      }
      const now = Date.now();
      const handoff: Handoff = {
        id: randomUUID(),
        sessionId: id,
        status: "waiting",
        reason: input.reason,
        instructions: input.instructions,
        doneWhen: input.doneWhen,
        requestedBy: client,
        requestedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + timeoutMs).toISOString(),
        resolvedAt: null,
        resolvedBy: null,
        note: null,
        liveUrl: `${this.deps.viewerUrl.replace(/\/$/, "")}/?session=${encodeURIComponent(id)}`,
      };
      this.handoffs.set(id, handoff);
      try {
        await this.persist(handoff);
      } catch (error) {
        this.handoffs.delete(id);
        throw error;
      }
      if (input.notify !== false) void this.deps.notify(handoff).catch(this.deps.log);
      return handoff;
    });
  }

  resolve(
    id: string,
    status: Exclude<Handoff["status"], "waiting">,
    client: string,
    note?: string,
    expectedId?: string,
  ): Promise<Handoff> {
    return this.serialize(id, async () => {
      const current = this.handoffs.get(id);
      if (!current) throw new AgentFeatureError(404, "handoff_not_found", "Handoff not found");
      if (current.status !== "waiting" || (expectedId !== undefined && current.id !== expectedId))
        return current;
      const next: Handoff = {
        ...current,
        status,
        resolvedAt: new Date().toISOString(),
        resolvedBy: client,
        note: note ?? null,
      };
      this.handoffs.set(id, next);
      try {
        await this.persist(next);
      } catch (error) {
        this.handoffs.set(id, current);
        throw error;
      }
      return next;
    });
  }

  private async persist(handoff: Handoff) {
    await this.deps.store.write(`handoffs/${handoff.sessionId}.json`, handoff);
    const session = this.deps.getSession(handoff.sessionId);
    if (session) Object.assign(session, { handoff });
    for (const resolve of this.waiters.get(handoff.sessionId) ?? []) resolve();
    this.deps.publish(`handoff.${handoff.status}`, handoff, handoff.sessionId);
    await this.deps.changed(handoff).catch(this.deps.log);
  }

  async wait(id: string, seconds: number, signal?: AbortSignal): Promise<Handoff> {
    const current = this.get(id);
    if (!current) throw new AgentFeatureError(404, "handoff_not_found", "Handoff not found");
    if (current.status !== "waiting" || seconds <= 0 || signal?.aborted) return current;
    await new Promise<void>((resolve) => {
      const listeners = this.waiters.get(id) ?? new Set<() => void>();
      this.waiters.set(id, listeners);
      const finish = () => {
        clearTimeout(timer);
        listeners.delete(finish);
        if (!listeners.size) this.waiters.delete(id);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, Math.min(50, seconds) * 1000);
      timer.unref();
      listeners.add(finish);
      signal?.addEventListener("abort", finish, { once: true });
      if (signal?.aborted || !this.isWaiting(id)) finish();
    });
    return this.get(id)!;
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      await Promise.all(
        this.list("waiting").map(async (handoff) => {
          if (Date.parse(handoff.expiresAt) <= Date.now()) {
            await this.resolve(handoff.sessionId, "expired", "timeout", undefined, handoff.id);
            return;
          }
          const session = this.deps.getSession(handoff.sessionId);
          if (!session || session.status !== "live") {
            await this.resolve(
              handoff.sessionId,
              "cancelled",
              "session",
              "The session ended",
              handoff.id,
            );
            return;
          }
          const condition = handoff.doneWhen;
          if (!condition || !Object.values(condition).some(Boolean)) return;
          try {
            const page = await activePage(session);
            if (!page) return;
            // Run user patterns in Chrome, not on the API's event loop.
            const matches = await bounded(
              page.evaluate(
                ({ selector, selectorGone, urlMatches, urlNotMatches }) =>
                  (!urlMatches || new RegExp(urlMatches).test(location.href)) &&
                  (!urlNotMatches || !new RegExp(urlNotMatches).test(location.href)) &&
                  (!selector || !!document.querySelector(selector)) &&
                  (!selectorGone || !document.querySelector(selectorGone)),
                condition,
              ),
            );
            if (matches)
              await this.resolve(handoff.sessionId, "done", "condition", undefined, handoff.id);
          } catch (error) {
            this.deps.log(error);
          }
        }),
      );
    } finally {
      this.polling = false;
    }
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    await Promise.all(
      this.list("waiting").map((handoff) =>
        this.resolve(handoff.sessionId, "cancelled", "shutdown", undefined, handoff.id),
      ),
    );
    for (const callbacks of this.waiters.values()) for (const callback of callbacks) callback();
  }
}
