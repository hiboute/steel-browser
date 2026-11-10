import type { Actor } from "./control/access.js";
import { v5 as uuidv5 } from "uuid";
import type { FastifyBaseLogger } from "fastify";
import { WarmSettings, type WarmInput, type WarmRecord } from "../modules/extras/extras.schema.js";
import type { SessionService, StartSessionOptions } from "./session.service.js";
import type { PlatformStore } from "./platform/store.js";
import { ExtrasError } from "./extract.service.js";
import { safeGoto } from "../utils/scrape/safeGoTo.js";

export const warmSessionId = (name: string) => uuidv5(`steel:warm:${name}`, uuidv5.URL);

export class WarmService {
  private records = new Map<string, WarmRecord>();
  private timer?: NodeJS.Timeout;
  private pending: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(
    private sessions: SessionService,
    private store: PlatformStore,
    private logger: FastifyBaseLogger,
  ) {}

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const task = this.pending.catch(() => undefined).then(action);
    this.pending = task;
    return task;
  }

  async initialize() {
    const saved = await this.store.read<WarmRecord[]>("warm.json");
    for (const record of saved ?? []) {
      const settings = WarmSettings.strip().parse(record);
      this.records.set(record.name, {
        ...settings,
        name: record.name,
        client: record.client,
        ownerId: record.ownerId,
        ownerAuthenticated: record.ownerAuthenticated,
        sessionId: warmSessionId(record.name),
        status: settings.enabled ? "waiting" : "disabled",
      });
    }
    this.timer = setInterval(
      () =>
        void this.tick().catch((err) =>
          this.logger.error({ err }, "Warm session reconciliation failed"),
        ),
      10000,
    );
    this.timer.unref();
    // Do not wait for a browser launch during Fastify's initialization hooks.
    void this.tick().catch((err) => this.logger.error({ err }, "Warm session startup failed"));
  }

  list(): WarmRecord[] {
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  async put(
    name: string,
    input: WarmInput,
    client = "anonymous",
    actor?: Actor,
  ): Promise<WarmRecord> {
    await this.serial(async () => {
      const enabled = [...this.records.values()].filter((r) => r.name !== name && r.enabled).length;
      if (input.enabled && enabled >= Math.max(0, this.sessions.maxSessions - 1)) {
        throw new ExtrasError(
          "warm_limit",
          "Warm sessions must leave at least one browser slot for user work",
          409,
        );
      }
      const previous = this.records.get(name);
      if (previous) await this.release(previous.sessionId);
      this.records.set(name, {
        ...input,
        name,
        client: previous?.client ?? client,
        ownerId: previous?.ownerId ?? actor?.id,
        ownerAuthenticated: previous?.ownerAuthenticated ?? actor?.authenticated,
        sessionId: warmSessionId(name),
        status: input.enabled ? "waiting" : "disabled",
      });
      await this.save();
    });
    await this.tick();
    return this.records.get(name)!;
  }

  async remove(name: string) {
    return this.serial(async () => {
      const record = this.records.get(name);
      if (!record) throw new ExtrasError("warm_not_found", "Warm session not found", 404);
      this.records.delete(name);
      await this.save();
      await this.release(record.sessionId);
    });
  }

  async restart(name: string) {
    await this.serial(async () => {
      const record = this.records.get(name);
      if (!record) throw new ExtrasError("warm_not_found", "Warm session not found", 404);
      await this.release(record.sessionId);
      record.status = record.enabled ? "waiting" : "disabled";
      await this.save();
    });
    await this.tick();
    return this.records.get(name)!;
  }

  private async release(id: string) {
    if (this.sessions.getSession(id)) await this.sessions.endSession(id);
  }

  tick(): Promise<void> {
    return this.serial(async () => {
      if (this.closed || this.sessions.isClosing) return;
      for (const record of this.records.values()) {
        if (!record.enabled || this.closed || this.sessions.isClosing) continue;
        const current = this.sessions.getSession(record.sessionId);
        const refresh =
          record.refreshMinutes &&
          record.lastStartedAt &&
          Date.now() - Date.parse(record.lastStartedAt) >= record.refreshMinutes * 60000;
        if (current?.status === "live" && !refresh) {
          record.status = "live";
          continue;
        }
        if (refresh && current) await this.release(record.sessionId);
        const pool = this.sessions.getPoolStatus();
        if (pool.queued > 0 || pool.free <= 1) {
          record.status = "waiting";
          continue;
        }
        record.status = "starting";
        try {
          const parked = this.sessions.getSession(record.sessionId);
          if (parked?.status === "parked") {
            await this.sessions.resumeSession(record.sessionId, { queueTimeout: 0 });
          } else {
            await this.sessions.startSession({
              sessionId: record.sessionId,
              name: record.name,
              labels: { warm: record.name },
              keepAlive: true,
              timeout: 0,
              queueTimeout: 0,
              credentials: {},
              browserProfile: record.browserProfile,
              cookieSets: record.cookieSets,
              egress: record.egress,
              extensions: record.extensions,
              client: record.client ?? "anonymous",
              _principal: record.ownerId
                ? {
                    id: record.ownerId,
                    role: "agent",
                    authenticated: record.ownerAuthenticated ?? false,
                  }
                : undefined,
            } as StartSessionOptions);
          }
          const session = this.sessions.getSession(record.sessionId);
          if (record.startUrl && session) {
            await safeGoto(await session.cdpService.getPrimaryPage(), record.startUrl, {
              timeout: 30000,
              waitUntil: "domcontentloaded",
            });
          }
          record.status = "live";
          record.lastStartedAt = new Date().toISOString();
          delete record.lastError;
        } catch (error) {
          record.status = "error";
          record.lastError = error instanceof Error ? error.message : "Warm session failed";
          await this.release(record.sessionId).catch(() => undefined);
          this.logger.warn({ err: error, name: record.name }, "Warm session launch failed");
        }
      }
      await this.save();
    });
  }

  private save() {
    return this.store.write("warm.json", [...this.records.values()]);
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.pending.catch(() => undefined);
  }
}
