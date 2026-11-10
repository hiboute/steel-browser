import path from "node:path";
import { stat } from "node:fs/promises";
import { browserProfilesDir, BROWSER_PROFILE_NAME } from "../session.service.js";
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
import { StorageService } from "../storage/storage.service.js";
import { requestJsonSchema, COMMANDS_API_VERSION } from "../commands/commands.js";
import devtoolsRoutes from "../../modules/next-platform/devtools.routes.js";
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
    storage: StorageService;
  }
}
const plugin: FastifyPluginAsync = async (server) => {
  const context = new AsyncLocalStorage<Actor>();
  const publish = (type: string, data: unknown, id?: string) =>
    server.events.publish(type, data, id);
  const commands = new SessionCommands(server.sessionService, server.fileService, {
    capture: (id) => {
      const generation = control.get(id)?.generation;
      return () => {
        if (generation === undefined || !control.isGenerationCurrent(id, generation))
          throw new AccessError(
            "control_required",
            "Command control has expired or transferred",
            409,
          );
      };
    },
    interaction: async (id, url) => (server as any).identity?.interactionForSession(id, url),
  });
  let runs: RunService;
  const control = new OwnershipService(server.store, async (id, lease) => {
    await commands.fence(id);
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
  const liveIds = () =>
    new Set([
      ...server.sessionService.listSessions(true).map((session) => session.id),
      server.sessionService.activeSession?.id,
    ]) as Set<string>;
  const storage: StorageService = new StorageService({
    store: server.store,
    activeIds: liveIds,
    external: {
      "browser-profiles": {
        label: "Saved browsers",
        path: browserProfilesDir(),
        retention: "Kept until deleted",
      },
      "cookie-library": {
        label: "Cookie library",
        path: process.env.COOKIE_LIBRARY_DIR || path.join(process.cwd(), "cookie-library"),
        retention: "Kept until deleted",
      },
      ...(process.env.LOG_STORAGE_PATH
        ? {
            logs: {
              label: "Browser logs",
              path: process.env.LOG_STORAGE_PATH,
              retention: "Kept until deleted",
            },
          }
        : {}),
    },
    sweeps: { control: () => control.prune(liveIds(), storage.controlDays) },
  });
  server.decorate("storage", storage);
  server.decorateRequest("steelPrincipal");
  await control.initialize();
  await budgets.initialize();
  for (const session of server.sessionService.listSessions(true))
    if (session.ownerId) await control.registerResource(session.id, session.ownerId);
  // The idle browser gets a new id each time the last session ends. Keep its
  // ownership record in step, or nobody can take control of it afterwards.
  let idleId: string | undefined;
  const registerIdle = async (boot = false) => {
    const idle = server.sessionService.activeSession;
    if (!idle?.id || idle.id === idleId || (!boot && idle.status !== "idle")) return;
    const previous = idleId;
    idleId = idle.id;
    await control.registerResource(idle.id, "local");
    if (previous) await control.forget(previous);
  };
  await registerIdle(true);
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
    const reserved = new Set([
      "pool",
      "by-name",
      "release",
      "cast",
      "debug",
      "live",
      "stream",
      "scrape",
      "screenshot",
      "pdf",
    ]);
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
        /^\/v1\/sessions\/(debug|cast|stream|live|scrape|screenshot|pdf)$/.test(path) ||
        /^\/(?:v1\/)?(?:json|devtools)(?:\/|$)/.test(path) ||
        (path === "/v1/events" && write) ||
        path.startsWith("/selenium/wd/")
      )
        id = server.sessionService.activeSession.id;
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
      const warmPath = /^\/v1\/warm\/([^/]+)/.exec(path);
      if (write && warmPath) {
        const record = server.warmService
          ?.list()
          .find((r) => r.name === decodeURIComponent(warmPath[1]));
        if (record && server.sessionService.getSession(record.sessionId))
          access.authorizeSession(request, record.sessionId, true);
      }
      const actor = request.steelPrincipal;
      if (actor && actor.role !== "operator") {
        if (write && (/^\/v1\/extensions(?:\/|$)/.test(path) || path === "/selenium/wd/session"))
          access.operator(actor);
        const profile = /^\/v1\/browser-profiles\/([^/]+)/.exec(path);
        if (profile) access.assertRead(actor, `profile:${decodeURIComponent(profile[1])}`);
        const warm = /^\/v1\/warm\/([^/]+)/.exec(path);
        if (warm) {
          const record = server.warmService
            ?.list()
            .find((r) => r.name === decodeURIComponent(warm[1]));
          if (record && record.ownerId !== actor.id)
            throw new AccessError("warm_denied", "Warm browser belongs to another principal");
        }
        const watcher = /^\/v1\/watchers\/([^/]+)/.exec(path);
        if (watcher) {
          const record = server.watcherService?.get(decodeURIComponent(watcher[1]));
          if (record?.ownerId !== actor.id)
            throw new AccessError("watcher_denied", "Watcher belongs to another principal");
        }
        if (path === "/v1/files" && !id)
          throw new AccessError("session_filter_required", "Select one authorized session");
      }
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
    if (Array.isArray(p.profiles))
      p.profiles = p.profiles.filter((r: any) =>
        control.canRead(`profile:${r.name}`, request.steelPrincipal),
      );
    for (const collection of ["warm", "watchers"])
      if (Array.isArray(p[collection]))
        p[collection] = p[collection].filter((r: any) => r.ownerId === request.steelPrincipal?.id);
    if (request.url.split("?", 1)[0] === "/v1/pool") {
      if (Array.isArray(p.queue))
        p.queue = p.queue.filter((r: any) => control.canRead(r.sessionId, request.steelPrincipal));
      if (Array.isArray(p.slots))
        p.slots = p.slots.map((s: any) =>
          s.sessionId && !control.canRead(s.sessionId, request.steelPrincipal)
            ? { index: s.index, primary: s.primary, state: s.state, sessionId: null }
            : s,
        );
    }
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
      if (
        options._principal.role !== "operator" &&
        (options.userDataDir || options.extra || options.logSinkUrl || options.caCertificates)
      )
        throw new AccessError(
          "operator_options_required",
          "Raw profile paths and launch/runtime hooks require operator authorization",
        );
    },
    onAdmission: async (options) => {
      if (options.browserProfile) {
        const name = options.browserProfile;
        if (!BROWSER_PROFILE_NAME.test(name))
          throw new AccessError("invalid_profile", "Invalid profile name", 400);
        const key = `profile:${name}`,
          actor = options._principal!;
        if (control.owner(key)) access.assertRead(actor, key);
        else {
          const exists = await stat(path.join(browserProfilesDir(), name))
            .then(() => true)
            .catch((e: any) => {
              if (e.code === "ENOENT") return false;
              throw e;
            });
          if (exists && actor.role !== "operator")
            throw new AccessError(
              "profile_owner_required",
              "An operator must assign this existing profile before agent access",
              409,
            );
          await control.registerResource(key, actor.id);
        }
      }
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
      await control.invalidate(session.id);
      await budgets.detach(session.id);
    },
    onEnded: async (session) => {
      budgets.release(session.id);
      await registerIdle();
    },
    onParked: async (session) => {
      budgets.release(session.id);
      await registerIdle();
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
  const sweep = setInterval(() => {
    void checkpoints
      .sweep()
      .catch((err) => server.log.error({ err }, "Checkpoint retention failed"));
    void storage.prune().catch((err) => server.log.error({ err }, "Storage pruning failed"));
  }, 3600000);
  sweep.unref();
  // Kind providers register before onReady; restart recovery can then classify custom steps correctly.
  server.addHook("onReady", async () => {
    await runs.initialize(false);
    await checkpoints.sweep();
    await storage.prune().catch((err) => server.log.error({ err }, "Storage pruning failed"));
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
  // The schema is the same for every browser; clients should not need one open to read it.
  const commandsSchema = requestJsonSchema();
  server.get(
    "/v1/commands/schema",
    {
      schema: { operationId: "get_commands_schema_static", tags: ["Commands"] },
      serializerCompiler: () => (data) => JSON.stringify(data),
    },
    async () => ({ version: COMMANDS_API_VERSION, schema: commandsSchema }),
  );
  await server.register(nextRoutes, { prefix: "/v1" });
  await server.register(devtoolsRoutes, { prefix: "/v1" });
};
export default fp(plugin, { name: "next-platform", dependencies: ["steel-platform"] });
