import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { CreateSession } from "../sessions/sessions.schema.js";
import { BROWSER_PROFILE_NAME } from "../../services/session.service.js";
import { AccessError } from "../../services/control/access.js";
const lease = z.object({
  mode: z.enum(["human", "agent"]),
  ttlMs: z.number().int().min(1000).max(300000).optional(),
});
const sid = (req: FastifyRequest) =>
  z
    .string()
    .min(1)
    .max(128)
    .parse((req.params as any).id);
const token = (req: FastifyRequest) =>
  typeof req.headers["x-steel-control"] === "string" ? req.headers["x-steel-control"] : "";
async function result(reply: FastifyReply, fn: () => unknown | Promise<unknown>) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AccessError)
      return reply.code(e.statusCode).send({ success: false, code: e.code, message: e.message });
    if (e instanceof z.ZodError)
      return reply
        .code(400)
        .send({ success: false, code: "invalid_request", message: "Request validation failed" });
    throw e;
  }
}
export default async function routes(server: FastifyInstance) {
  const route = (
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    operationId: string,
    fn: (req: FastifyRequest, reply: FastifyReply) => unknown | Promise<unknown>,
  ) =>
    server.route({
      method,
      url,
      schema: { operationId, tags: ["Browser Work Platform"] },
      handler: (req, reply) => result(reply, () => fn(req, reply)),
    });
  route("GET", "/sessions/:id/control", "get_browser_control", (req) => ({
    lease: server.control.get(sid(req)),
  }));
  route("POST", "/sessions/:id/control/acquire", "acquire_browser_control", (req) =>
    server.control.acquire(sid(req), server.access.actor(req), lease.parse(req.body)),
  );
  route("POST", "/sessions/:id/control/renew", "renew_browser_control", (req) =>
    server.control.renew(
      sid(req),
      server.access.actor(req),
      token(req),
      z.object({ ttlMs: lease.shape.ttlMs }).parse(req.body ?? {}).ttlMs,
    ),
  );
  route("POST", "/sessions/:id/control/release", "release_browser_control", async (req) => {
    await server.control.release(sid(req), server.access.actor(req), token(req));
    return { success: true };
  });
  route("POST", "/sessions/:id/control/transfer", "transfer_browser_control", (req) =>
    server.control.transfer(
      sid(req),
      server.access.actor(req),
      token(req),
      lease.extend({ ownerId: z.string().min(1).max(128).optional() }).parse(req.body),
    ),
  );
  route("POST", "/sessions/:id/control/ticket", "issue_browser_control_ticket", (req) => {
    const body = z
      .object({ channel: z.enum(["cdp", "cast"]), observer: z.boolean().optional() })
      .parse(req.body);
    if (body.observer) {
      if (body.channel !== "cast")
        throw new AccessError("invalid_ticket", "Observer tickets support cast only", 400);
      return server.control.issueObserverTicket(sid(req), server.access.actor(req));
    }
    return server.control.issueTicket(sid(req), server.access.actor(req), token(req), body.channel);
  });
  route("PUT", "/browser-profiles/:id/owner", "assign_browser_profile_owner", async (req) => {
    server.access.operator(server.access.actor(req));
    const name = sid(req);
    if (!BROWSER_PROFILE_NAME.test(name))
      throw new AccessError("invalid_profile", "Invalid profile name", 400);
    if (server.sessionService.profileHolder(name))
      throw new AccessError(
        "profile_busy",
        "Release the saved browser before assigning ownership",
        409,
      );
    const { ownerId } = z
      .object({ ownerId: z.string().min(1).max(128) })
      .strict()
      .parse(req.body);
    await server.control.assignResource(`profile:${name}`, ownerId);
    return { name, ownerId };
  });
  route("GET", "/runs", "list_task_runs", (req) => ({
    runs: server.runs.list(server.access.actor(req)),
  }));
  route("POST", "/runs", "create_task_run", (req) =>
    server.runs.create(
      {
        ...z
          .object({
            sessionId: z.string().optional(),
            sessionOptions: CreateSession.optional(),
            steps: z.array(
              z.object({
                id: z.string(),
                kind: z.string(),
                input: z.unknown(),
                retry: z.object({ maxAttempts: z.number(), delayMs: z.number() }).optional(),
              }),
            ),
            metadata: z.record(z.string(), z.unknown()).optional(),
            idempotencyKey: z.string().max(200).optional(),
          })
          .strict()
          .parse(req.body),
        controlToken: token(req) || undefined,
      } as any,
      server.access.actor(req),
    ),
  );
  route("GET", "/runs/:id", "get_task_run", (req) =>
    server.runs.get(sid(req), server.access.actor(req)),
  );
  route("POST", "/runs/:id/cancel", "cancel_task_run", (req) =>
    server.runs.cancel(sid(req), server.access.actor(req)),
  );
  route("POST", "/runs/:id/resume", "resume_task_run", (req) =>
    server.runs.resume(
      sid(req),
      server.access.actor(req),
      z
        .object({
          resolution: z
            .object({
              stepId: z.string(),
              outcome: z.enum(["applied", "not_applied"]),
              evidence: z.string().min(1).max(4000),
            })
            .optional(),
        })
        .parse(req.body ?? {}),
    ),
  );
  route("GET", "/checkpoints", "list_browser_checkpoints", async (req) => ({
    checkpoints: await server.checkpoints.list(server.access.actor(req)),
  }));
  route("POST", "/sessions/:id/checkpoints", "create_browser_checkpoint", (req) =>
    server.checkpoints.create(
      sid(req),
      z.object({ name: z.string(), retentionDays: z.number().int().optional() }).parse(req.body),
      server.access.actor(req),
    ),
  );
  route("GET", "/checkpoints/:id", "get_browser_checkpoint", (req) =>
    server.checkpoints.get(sid(req), server.access.actor(req)),
  );
  route("POST", "/checkpoints/:id/branch", "branch_browser_checkpoint", (req) =>
    server.checkpoints.branch(
      sid(req),
      z.object({ name: z.string().max(128).optional() }).parse(req.body ?? {}),
      server.access.actor(req),
    ),
  );
  route("DELETE", "/checkpoints/:id", "delete_browser_checkpoint", async (req) => {
    await server.checkpoints.remove(sid(req), server.access.actor(req));
    return { success: true };
  });
  route("POST", "/sessions/:id/diagnose", "diagnose_browser", (req) =>
    server.doctor.diagnose(sid(req), server.access.actor(req)),
  );
  route("GET", "/diagnostics/:id", "get_browser_diagnosis", (req) =>
    server.doctor.get(sid(req), server.access.actor(req)),
  );
  route("GET", "/diagnostics/:id/bundle", "download_browser_diagnosis", async (req, reply) =>
    reply
      .header("content-disposition", `attachment; filename="steel-diagnostic-${sid(req)}.json"`)
      .type("application/json")
      .send(await server.doctor.get(sid(req), server.access.actor(req))),
  );
  route("GET", "/budgets", "get_browser_budgets", (req) => {
    server.access.operator(server.access.actor(req));
    return server.budgets.get();
  });
  route("PUT", "/budgets", "configure_browser_budgets", (req) => {
    server.access.operator(server.access.actor(req));
    return server.budgets.configure(
      z
        .object({
          defaultMaxConcurrent: z.number().int(),
          clients: z.record(
            z.string(),
            z.object({ maxConcurrent: z.number().int(), weight: z.number().int() }),
          ),
          sites: z.record(z.string(), z.object({ maxConcurrent: z.number().int() })),
        })
        .parse(req.body),
    );
  });
}
