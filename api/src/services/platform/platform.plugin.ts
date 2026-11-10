import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { platformEnv } from "./config.js";
import { PlatformStore } from "./store.js";
import { PlatformEvents } from "./events.js";
import { AuditLog } from "./audit.js";
import { Notifier } from "./notifier.js";
import { Metrics } from "./metrics.js";
import { MemoryGuard } from "./memory.js";
import { BackgroundJobs } from "./jobs.js";
import { EgressService } from "./egress.js";
import platformRoutes from "../../modules/platform/platform.routes.js";
import type { Session } from "../session.service.js";

declare module "fastify" {
  interface FastifyRequest {
    steelClient: string;
  }
  interface FastifyInstance {
    store: PlatformStore;
    events: PlatformEvents;
    audit: AuditLog;
    notifier: Notifier;
    metrics: Metrics;
    memory: MemoryGuard;
    jobs: BackgroundJobs;
    egress: EgressService;
  }
}

const platformPlugin: FastifyPluginAsync = async (server) => {
  const store = new PlatformStore(
    platformEnv.STEEL_DATA_DIR,
    platformEnv.STEEL_DATA_KEY || platformEnv.COOKIE_LIBRARY_KEY,
  );
  const events = new PlatformEvents();
  const audit = new AuditLog(store, platformEnv.AUDIT_RETENTION_DAYS);
  const metrics = new Metrics();
  const notifier = new Notifier(
    store,
    events,
    server.log,
    platformEnv.NOTIFY_WEBHOOK_URL,
    platformEnv.STEEL_VIEWER_URL,
  );
  const jobs = new BackgroundJobs(server.sessionService, platformEnv.BACKGROUND_MAX_SESSIONS);
  const memory = new MemoryGuard(platformEnv.MIN_FREE_MEMORY_MB * 1024 * 1024);
  const egress = new EgressService(platformEnv.EGRESS_PROFILES, platformEnv.DEFAULT_EGRESS);
  server.decorate("store", store);
  server.decorate("events", events);
  server.decorate("audit", audit);
  server.decorate("metrics", metrics);
  server.decorate("notifier", notifier);
  server.decorate("jobs", jobs);
  server.decorate("memory", memory);
  server.decorate("egress", egress);
  server.decorateRequest("steelClient", "anonymous");
  server.addHook("onRequest", async (request, reply) => {
    const client = request.headers["x-steel-client"];
    if (
      client !== undefined &&
      (typeof client !== "string" || client.length > 128 || /[\r\n\0]/.test(client))
    ) {
      return reply.code(400).send({
        success: false,
        code: "invalid_client",
        message: "X-Steel-Client must be at most 128 characters",
      });
    }
    request.steelClient = typeof client === "string" && client.trim() ? client.trim() : "anonymous";
  });
  server.addHook("onResponse", async (_request, reply) => {
    if (reply.statusCode === 429) metrics.increment("steel_pool_rejections_total");
  });
  const sessionEvent = (type: string, session: Session) => {
    const { id, status, name, client, slot, labels } = session;
    events.publish(type, { id, status, name, client, slot, labels }, id);
  };
  const unhook = server.sessionService.hooks.add({
    onStarted: async (session) => {
      await server.fileService.markLive(session.id);
      metrics.increment("steel_sessions_started_total");
      sessionEvent("session.started", session);
    },
    onEnding: async (session, { reason, park }) => {
      await audit.log(park ? "session.parking" : "session.ending", {
        client: session.client,
        sessionId: session.id,
        detail: { reason },
      });
      if (reason === "idle" || reason === "timeout")
        metrics.increment("steel_sessions_reaped_total", { reason });
    },
    onEnded: async (session) => {
      await server.fileService.markReleased(session.id);
      sessionEvent("session.ended", session);
    },
    onParked: async (session) => {
      sessionEvent("session.parked", session);
    },
    onResumed: async (session) => {
      await server.fileService.markLive(session.id);
      sessionEvent("session.resumed", session);
    },
  });
  let lastQueue = "";
  const poll = setInterval(() => {
    const pool = server.sessionService.getPoolStatus();
    const identity = JSON.stringify(pool.queue.map((entry) => entry.sessionId));
    if (identity !== lastQueue) {
      lastQueue = identity;
      events.publish("pool.queue", { queued: pool.queued, queue: pool.queue });
    }
  }, 1000);
  poll.unref();
  const sweep = async () => {
    await audit.sweep();
    await server.fileService.sweepReleased(
      new Set(server.sessionService.listSessions(true).map((session) => session.id)),
      platformEnv.FILES_RETENTION_HOURS,
    );
  };
  const sweepTimer = setInterval(() => {
    void sweep().catch((err) => server.log.warn({ err }, "Platform retention sweep failed"));
  }, 3_600_000);
  sweepTimer.unref();
  await sweep();
  await server.register(platformRoutes);
  server.addHook("preClose", async () => {
    clearInterval(poll);
    clearInterval(sweepTimer);
    await jobs.close();
  });
  server.addHook("onClose", async () => {
    unhook();
    await notifier.flush();
    await store.flush();
    await server.fileService.close();
  });
};

export default fp(platformPlugin, { name: "steel-platform" });
