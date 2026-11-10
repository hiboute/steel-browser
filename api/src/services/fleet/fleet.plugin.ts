import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { z } from "zod";
import { FleetService } from "./fleet.service.js";
import { FleetError } from "./types.js";
import { assertStrictEgress } from "./strict-egress.js";
import { BrowserEgressDiagnostics } from "./egress-diagnostics.js";

const engine = z.enum(["chromium", "firefox", "webkit", "safari", "android"]);
const command = z.enum(["goto", "click", "fill", "press", "snapshot", "screenshot", "evaluate", "cookies", "checkpoint", "close"]);
const capabilities = z.object({ protocol: z.literal(1), engines: z.array(engine).min(1).max(5), commands: z.array(z.enum(["launch", ...command.options])).min(1).max(12), capacity: z.number().int().min(1).max(16), device: z.object({ kind: z.enum(["desktop", "android"]), os: z.string().min(1).max(100), graphics: z.enum(["native", "software", "unknown"]), headless: z.boolean() }), strictEgress: z.boolean(), browserVersions: z.partialRecord(engine, z.string().max(100)) });
const pairing = z.object({ label: z.string().min(1).max(100), location: z.string().min(1).max(100), engines: z.array(engine).min(1), profileScope: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).optional() });
type Actor = { id: string; role: string; authenticated: boolean };
function access(server: FastifyInstance): any { const value = (server as any).access; if (!value) throw new FleetError("fleet_auth_unavailable", "Fleet requires the authenticated control platform", 503); return value; }
function operator(server: FastifyInstance, request: FastifyRequest): Actor { const actor = access(server).actor(request) as Actor; if (!actor.authenticated || actor.role !== "operator") throw new FleetError("operator_required", "Authenticated operator access required", 403); return actor; }
function bearer(request: FastifyRequest) { const token = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{32,128})$/)?.[1]; if (!token) throw new FleetError("worker_auth_required", "Worker token required", 401); return token; }
function id(request: FastifyRequest, key = "id") { return z.string().uuid().parse((request.params as Record<string, unknown>)[key]); }

declare module "fastify" { interface FastifyInstance { fleet: FleetService; egressDiagnostics: BrowserEgressDiagnostics; } }
const fleetPlugin: FastifyPluginAsync = async (server) => {
  const fleet = new FleetService(server.store, Date.now, 45_000, (sessionId, generation) => (server as any).control?.isGenerationCurrent(sessionId, generation) ?? false);
  const diagnostics = new BrowserEgressDiagnostics(server.sessionService, server.store);
  server.decorate("fleet", fleet); server.decorate("egressDiagnostics", diagnostics);
  // The platform hook runs after named egress resolution and before browser admission.
  (server.sessionService as any).setLaunchPolicy?.((options: { egressPolicy?: string; proxyUrl?: string }) => assertStrictEgress(options.egressPolicy, options.proxyUrl));
  await server.register(async routes => {
    routes.setErrorHandler((error: any, _request, reply) => {
      if (error instanceof z.ZodError) return reply.code(400).send({ code: "invalid_fleet_request", message: "Invalid fleet request", issues: error.issues.map(i => ({ path: i.path, message: i.message })) });
      return reply.code(error.statusCode ?? 500).send({ code: error.code ?? "fleet_error", message: error.statusCode ? error.message : "Fleet operation failed" });
    });
    routes.get("/fleet/workers", async request => { operator(server, request); return { workers: fleet.listWorkers() }; });
    routes.post("/fleet/pairings", async request => { operator(server, request); return fleet.pair(pairing.parse(request.body)); });
    routes.post("/fleet/workers/:id/:action", async request => { operator(server, request); return fleet.setWorker(id(request), z.enum(["drain", "resume", "revoke"]).parse((request.params as any).action)); });
    routes.post("/fleet/worker/register", { config: { steelWorkerAuth: true } as any }, async request => { const body = z.object({ pairingToken: z.string().min(40).max(100), capabilities }).parse(request.body); return fleet.register(body.pairingToken, body.capabilities); });
    routes.post("/fleet/worker/:id/poll", { config: { steelWorkerAuth: true } as any }, async request => { const body = z.object({ liveSessionIds: z.array(z.string().uuid()).max(16) }).parse(request.body); return fleet.poll(id(request), bearer(request), body.liveSessionIds); });
    routes.post("/fleet/worker/:id/commands/:commandId/result", { config: { steelWorkerAuth: true } as any, bodyLimit: 12 * 1024 * 1024 }, async request => { const body = z.object({ generation: z.number().int().positive(), result: z.unknown().optional(), error: z.string().max(200).optional() }).parse(request.body); return fleet.complete(id(request), bearer(request), id(request, "commandId"), body.generation, body); });
    routes.get("/fleet/sessions", async request => { const actor = access(server).actor(request); return { sessions: fleet.listSessions(actor.role === "operator" ? undefined : actor.id) }; });
    routes.post("/fleet/sessions", async request => {
      const actor = access(server).actor(request); if (!actor.authenticated) throw new FleetError("authentication_required", "Fleet session creation requires authentication", 401);
      const body = z.object({ engine, workerId: z.string().uuid().optional(), location: z.string().max(100).optional(), egressPolicy: z.enum(["standard", "strict"]).optional(), checkpointId: z.string().uuid().optional(), headless: z.boolean().optional() }).parse(request.body);
      const result = await fleet.createSession({ ...body, ownerId: actor.id });
      await (server as any).control.registerResource(result.session.id, actor.id); return result;
    });
    routes.get("/fleet/sessions/:id", async request => { await access(server).authorizeSession(request, id(request), false); return fleet.getSession(id(request)); });
    routes.post("/fleet/sessions/:id/commands", async request => { await access(server).authorizeSession(request, id(request), true); const body = z.object({ kind: command, payload: z.record(z.string(), z.unknown()).default({}), idempotencyKey: z.string().min(1).max(200) }).parse(request.body); const generation = (server as any).control.get(id(request))?.generation; if (generation === undefined) throw new FleetError("control_required", "Acquire control before issuing fleet commands", 409); return fleet.command(id(request), body.kind, body.payload, body.idempotencyKey, generation); });
    routes.get("/fleet/sessions/:id/commands/:commandId", async request => { await access(server).authorizeSession(request, id(request), false); return fleet.getCommand(id(request), id(request, "commandId")); });
    routes.post("/fleet/sessions/:id/commands/:commandId/reconcile", async request => { operator(server, request); await access(server).authorizeSession(request, id(request), true); const body = z.object({ decision: z.enum(["applied", "not_applied"]), result: z.unknown().optional() }).parse(request.body); return fleet.reconcile(id(request), id(request, "commandId"), body.decision, body.result); });
    routes.get("/fleet/checkpoints", async request => { const actor = access(server).actor(request); return { checkpoints: fleet.listCheckpoints(actor.role === "operator" ? undefined : actor.id) }; });
    routes.post("/sessions/:id/egress-diagnostics", async request => { await access(server).authorizeSession(request, id(request), true); return diagnostics.run(id(request)); });
    routes.get("/sessions/:id/egress-diagnostics", async request => { await access(server).authorizeSession(request, id(request), false); return diagnostics.get(id(request)); });
  }, { prefix: "/v1" });
  server.addHook("onReady", async () => { await fleet.initialize(); for (const session of fleet.listSessions()) await (server as any).control?.registerResource(session.id, session.ownerId); });
  server.addHook("preClose", async () => { await fleet.close(); });
};
export default fp(fleetPlugin, { name: "steel-fleet", dependencies: ["steel-platform"] });
