import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { AsyncLocalStorage } from "node:async_hooks";
import { AccessService, AccessError, type Actor } from "./access.js";
import { OwnershipService } from "./ownership.js";
import { BudgetService } from "./budgets.js";
import { SessionCommands } from "../commands/registry.js";
import { RunService } from "../runs/runs.service.js";
import { CheckpointService } from "../checkpoints/checkpoints.service.js";
import { DoctorService } from "../doctor/doctor.service.js";
import nextRoutes from "../../modules/next-platform/next-platform.routes.js";

declare module "fastify" {
  interface FastifyRequest {
    steelPrincipal: Actor;
  }
  interface FastifyInstance {
    access: AccessService;
    control: OwnershipService;
    budgets: BudgetService;
    sessionCommands: SessionCommands;
    runs: RunService;
    checkpoints: CheckpointService;
    doctor: DoctorService;
  }
}
const plugin: FastifyPluginAsync = async (server) => {
  const context = new AsyncLocalStorage<Actor>();
  const publish = (type: string, data: unknown, id?: string) =>
    server.events.publish(type, data, id);
  const commands = new SessionCommands(server.sessionService, server.fileService);
  let runs: RunService;
  const control = new OwnershipService(server.store, async (id, lease) => {
    commands.reset(id);
    publish("control.changed", { sessionId: id, lease }, id);
    if (lease?.mode === "human" || !lease)
      void runs
        ?.pauseForSession(id, lease ? "human_control" : "control_released")
        .catch((err) => server.log.error({ err }, "Cannot pause task after control change"));
  });
  const access = new AccessService(
    (id) => control.readers(id),
    (id, actor, token) => control.assert(id, actor, token),
  );
  const budgets = new BudgetService(server.store, access.configured);
  runs = new RunService(server.store, server.sessionService, commands, control, publish);
  const checkpoints = new CheckpointService(server.store, server.sessionService, publish);
  const doctor = new DoctorService(server.store, server.sessionService);
  server.decorate("access", access);
  server.decorate("control", control);
  server.decorate("budgets", budgets);
  server.decorate("sessionCommands", commands);
  server.decorate("runs", runs);
  server.decorate("checkpoints", checkpoints);
  server.decorate("doctor", doctor);
  server.decorateRequest("steelPrincipal");
  await control.initialize();
  await budgets.initialize();
  for (const session of server.sessionService.listSessions(true))
    if (session.ownerId) await control.registerResource(session.id, session.ownerId);
  await control.registerResource(server.sessionService.activeSession.id, "local");
  server.browserPool.setSchedulingPolicy(budgets);
  server.addHook("onRequest", (request, reply, done) => {
    const path = request.url.split("?", 1)[0];
    if (path === "/v1/health" && request.method === "GET") {
      done();
      return;
    }
    // Worker registration and polling authenticate their own single-use/worker credentials.
    if (/^\/v1\/fleet\/worker\/(register|[^/]+\/poll|[^/]+\/commands\/[^/]+\/result)$/.test(path)) {
      done();
      return;
    }
    try {
      request.steelPrincipal = access.authenticate(request);
      request.steelClient = request.steelPrincipal.id;
      context.run(request.steelPrincipal, done);
    } catch (error) {
      const e = error as AccessError;
      void reply
        .code(e.statusCode ?? 403)
        .send({ success: false, code: e.code, message: e.message });
    }
  });
  server.addHook("preHandler", async (request, reply) => {
    const path = request.url.split("?", 1)[0];
    const write = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    const match = /^\/v1\/sessions\/([^/]+)(?:\/|$)/.exec(path);
    const reserved = new Set(["pool", "by-name", "release", "cast", "debug", "live", "stream"]);
    const body = request.body as Record<string, unknown> | undefined;
    const query = request.query as Record<string, unknown> | undefined;
    let id =
      match && !reserved.has(match[1])
        ? decodeURIComponent(match[1])
        : typeof body?.sessionId === "string"
        ? body.sessionId
        : typeof query?.sessionId === "string"
        ? query.sessionId
        : undefined;
    if (path === "/v1/sessions" && request.method === "POST") id = undefined;
    try {
      if (path === "/v1/sessions/release" && !id && write)
        throw new AccessError(
          "scoped_release_required",
          "Release each session with its current control lease",
          409,
        );
      if (
        (request.method === "POST" && /^\/v1\/(scrape|screenshot|pdf|search)$/.test(path)) ||
        path.startsWith("/selenium/wd/")
      )
        id ??= server.sessionService.activeSession.id;
      if (id) {
        const controlRoute = /\/control(?:\/|$)/.test(path);
        access.authorizeSession(request, id, write && !controlRoute);
      }
      if (
        request.steelPrincipal?.role !== "operator" &&
        (/^\/v1\/(audit|notifications|recordings|handoffs|logs)(?:\/|$)/.test(path) ||
          path === "/metrics")
      )
        throw new AccessError(
          "operator_required",
          "Global browser history requires operator access",
        );
      if (path === "/v1/events" && request.steelPrincipal?.role !== "operator" && !id)
        throw new AccessError("session_filter_required", "Subscribe to one authorized session");
    } catch (error) {
      const e = error as AccessError;
      return reply
        .code(e.statusCode ?? 403)
        .serializer(JSON.stringify)
        .send({ success: false, code: e.code, message: e.message });
    }
  });
  server.addHook("preSerialization", async (request, reply, payload) => {
    if (request.steelPrincipal?.role === "operator" || !payload || typeof payload !== "object")
      return payload;
    const p = payload as any;
    if (Array.isArray(p.sessions))
      p.sessions = p.sessions.filter((s: any) => control.canRead(s.id, request.steelPrincipal));
    if (
      request.url.startsWith("/v1/sessions/by-name/") &&
      p.id &&
      !control.canRead(p.id, request.steelPrincipal)
    ) {
      reply.code(403);
      return {
        success: false,
        code: "session_denied",
        message: "Session belongs to another principal",
      };
    }
    return p;
  });
  const unsubscribe = server.sessionService.hooks.add({
    onStarting: async (options) => {
      options._principal ??= context.getStore() ?? {
        id: "system",
        role: "operator",
        authenticated: true,
      };
    },
    onAdmission: async (options) => {
      budgets.register(options);
      await control.registerResource(options.sessionId!, options._principal?.id ?? "system");
    },
    onBrowserReady: async (session) => {
      await budgets.attach(session);
    },
    onStarted: async (session) => {
      if (!session.isSelenium) commands.get(session.id);
    },
    onResumed: async (session) => {
      if (!session.isSelenium) commands.get(session.id);
    },
    onEnding: async (session) => {
      commands.reset(session.id);
      await control.invalidate(session.id);
      await budgets.detach(session.id);
    },
    onEnded: async (session) => {
      budgets.release(session.id);
    },
    onParked: async (session) => {
      budgets.release(session.id);
    },
  });
  const unsubscribeEvents = server.events.subscribe((event) => {
    if (event.sessionId && (event.type === "friction.detected" || event.type === "handoff.waiting"))
      void runs
        .pauseForSession(event.sessionId, event.type)
        .catch((err) => server.log.error({ err }, "Cannot pause task"));
  });
  const expiry = setInterval(
    () => void control.expire().catch((err) => server.log.error({ err }, "Lease expiry failed")),
    250,
  );
  expiry.unref();
  const sweep = setInterval(
    () =>
      void checkpoints
        .sweep()
        .catch((err) => server.log.error({ err }, "Checkpoint retention failed")),
    3600000,
  );
  sweep.unref();
  // Kind providers register before onReady; restart recovery can then classify custom steps correctly.
  server.addHook("onReady", async () => {
    await runs.initialize();
    await checkpoints.sweep();
  });
  server.addHook("preClose", async () => {
    clearInterval(sweep);
    clearInterval(expiry);
    await runs.close();
    commands.close();
    await budgets.close();
    await control.close();
    unsubscribe();
    unsubscribeEvents();
  });
  await server.register(nextRoutes, { prefix: "/v1" });
};
export default fp(plugin, { name: "next-platform", dependencies: ["steel-platform"] });
