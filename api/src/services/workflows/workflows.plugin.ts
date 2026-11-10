import fp from "fastify-plugin";
import type { FastifyError, FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { WorkflowService } from "./workflows.service.js";
import {
  ProductId,
  ProcedureInputSchema,
  ProcedureStartSchema,
  ReplayInputSchema,
  ScheduleInputSchema,
  WorkflowError,
  type WorkflowActor,
  type WorkflowRuntime,
  type StepContext,
  type ReviewRecord,
} from "./workflows.types.js";
import { toJsonSchema } from "../../utils/schema.js";

declare module "fastify" {
  interface FastifyInstance {
    workflowService: WorkflowService;
  }
}
type Host = FastifyInstance & {
  runs: WorkflowRuntime;
  access: { actor(request: FastifyRequest): WorkflowActor };
};
interface Options {
  runtime?: WorkflowRuntime;
  actor?: (request: FastifyRequest) => WorkflowActor;
  replayOrigins?: string[];
  replayAllowPrivateNetworks?: boolean;
  releaseReplaySession?: (sessionId: string) => Promise<void>;
  evidenceAllowed?: (sessionId: string) => boolean;
  isSensitiveSession?: (sessionId: string) => boolean;
  vaultFill?: (
    ctx: StepContext,
    input: { reference: string; selector: string; frameUrl?: string },
  ) => Promise<unknown>;
  verifyAttachment?: (
    ctx: StepContext,
    attachment: ReviewRecord["proposal"]["attachments"][number],
  ) => Promise<void>;
  authorizeWatcher?: (watcherId: string, actor: WorkflowActor) => Promise<void> | void;
}

const plugin: FastifyPluginAsync<Options> = async (server, options) => {
  const host = server as Host;
  const runtime = options.runtime ?? host.runs;
  if (!runtime || typeof runtime.pauseError !== "function")
    throw new Error("Steel workflows require the durable run service and its pauseError factory");
  const actor = options.actor ?? ((request: FastifyRequest) => host.access.actor(request));
  const replayOrigins =
    options.replayOrigins ??
    (process.env.STEEL_REPLAY_ORIGINS ?? "")
      .split(",")
      .filter(Boolean)
      .map((value) => new URL(value.trim()).origin);
  const workflows = new WorkflowService({
    store: server.store,
    runtime,
    events: server.events,
    replayOrigins,
    releaseReplaySession:
      options.releaseReplaySession ??
      (async (sessionId) => {
        await server.sessionService.endSession(sessionId);
      }),
    evidenceAllowed: options.evidenceAllowed,
    isSensitiveSession: options.isSensitiveSession,
    vaultFill: options.vaultFill,
    verifyAttachment: options.verifyAttachment,
    authorizeWatcher:
      options.authorizeWatcher ??
      ((watcherId, principal) => {
        const record = server.watcherService.get(watcherId);
        if (principal.role !== "operator" || !record)
          throw new WorkflowError(
            "watcher_forbidden",
            "Only an operator may bind a watcher trigger without a verified watcher-owner adapter",
            403,
          );
      }),
    replayAllowPrivateNetworks:
      options.replayAllowPrivateNetworks ??
      process.env.STEEL_REPLAY_ALLOW_PRIVATE_NETWORKS === "true",
    onError: (error) => server.log.warn({ err: error }, "Workflow background operation failed"),
  });
  server.decorate("workflowService", workflows);
  await server.register(
    async (routes) => {
      routes.setErrorHandler((error: FastifyError, request, reply) => {
        const status =
          error instanceof WorkflowError
            ? error.statusCode
            : error instanceof z.ZodError
            ? 400
            : error.statusCode ?? 500;
        if (status >= 500) request.log.error({ err: error }, "Workflow request failed");
        reply.code(status).send({
          code:
            error instanceof WorkflowError
              ? error.code
              : status < 500
              ? "invalid_request"
              : "workflow_failed",
          message: status < 500 ? error.message : "Workflow operation failed",
        });
      });
      const bodySchema = (schema: z.ZodType) => toJsonSchema(schema, { target: "draft-7" });
      const id = (request: FastifyRequest) =>
        ProductId.parse((request.params as { id: string }).id);
      const spec = (operationId: string, summary: string, body?: z.ZodType) => ({
        schema: {
          operationId,
          tags: ["Workflows"],
          summary,
          ...(body ? { body: bodySchema(body) } : {}),
        },
        ...(body
          ? {
              validatorCompiler: () => (data: unknown) => {
                const result = body.safeParse(data);
                return result.success ? { value: result.data } : { error: result.error };
              },
            }
          : {}),
      });
      routes.get(
        "/procedures",
        spec("list_procedures", "List reusable procedure versions"),
        async (request) => ({ procedures: workflows.listProcedures(actor(request)) }),
      );
      routes.post(
        "/procedures",
        spec("create_procedure", "Save a versioned procedure", ProcedureInputSchema),
        async (request) => workflows.saveProcedure(request.body, actor(request)),
      );
      routes.post(
        "/procedures/from-actions",
        spec(
          "procedure_from_actions",
          "Create an editable procedure from explicitly selected command actions",
          z
            .object({
              name: z.string().min(1).max(200),
              actions: z
                .array(z.object({ id: ProductId, input: z.unknown() }).strict())
                .min(1)
                .max(100),
              inputSchema: z.record(z.string(), z.unknown()).optional(),
            })
            .strict(),
        ),
        async (request) => workflows.createFromActions(request.body as any, actor(request)),
      );
      routes.get(
        "/procedures/:id",
        spec("get_procedure", "Read an immutable procedure version"),
        async (request) =>
          workflows.getProcedure(
            id(request),
            (request.query as { version?: string }).version
              ? z.coerce
                  .number()
                  .int()
                  .positive()
                  .parse((request.query as any).version)
              : undefined,
            actor(request),
          ),
      );
      routes.get(
        "/procedures/:id/versions",
        spec("list_procedure_versions", "List immutable procedure history"),
        async (request) => ({ versions: workflows.procedureVersions(id(request), actor(request)) }),
      );
      routes.put(
        "/procedures/:id",
        spec("update_procedure", "Create a new immutable procedure version", ProcedureInputSchema),
        async (request) =>
          workflows.saveProcedure({ ...(request.body as object), id: id(request) }, actor(request)),
      );
      routes.delete(
        "/procedures/:id",
        spec("delete_procedure", "Delete procedure definitions without deleting historical runs"),
        async (request) => {
          await workflows.removeProcedure(id(request), actor(request));
          return { deleted: true };
        },
      );
      routes.post(
        "/procedures/:id/run",
        spec(
          "run_procedure",
          "Execute a pinned procedure through the durable runner",
          ProcedureStartSchema,
        ),
        async (request) =>
          workflows.startProcedure(id(request), request.body, actor(request), {
            controlToken:
              typeof request.headers["x-steel-control"] === "string"
                ? request.headers["x-steel-control"]
                : undefined,
          }),
      );
      routes.get(
        "/reviews",
        spec("list_submission_reviews", "List exact-content submission reviews"),
        async (request) => ({ reviews: await workflows.listReviews(actor(request)) }),
      );
      routes.get(
        "/reviews/:id",
        spec("get_submission_review", "Read the exact proposed action"),
        async (request) => workflows.getReview(id(request), actor(request)),
      );
      routes.post(
        "/reviews/:id/decision",
        spec(
          "decide_submission_review",
          "Approve or reject the displayed content hash",
          z
            .object({
              decision: z.enum(["approve", "reject"]),
              contentHash: z.string().regex(/^[a-f0-9]{64}$/),
            })
            .strict(),
        ),
        async (request) => workflows.decideReview(id(request), request.body as any, actor(request)),
      );
      routes.get(
        "/receipts",
        spec("list_completion_receipts", "List verified, waiting, failed and uncertain receipts"),
        async (request) => ({ receipts: await workflows.listReceipts(actor(request)) }),
      );
      routes.get(
        "/receipts/:id",
        spec("get_completion_receipt", "Evaluate persisted run evidence into a completion receipt"),
        async (request) => workflows.getReceipt(id(request), actor(request)),
      );
      routes.get(
        "/workflow-evidence/:id",
        spec("get_workflow_evidence", "Download owner-scoped receipt evidence"),
        async (request, reply) => {
          const evidence = await workflows.getEvidence(id(request), actor(request));
          return reply
            .header("Cache-Control", "private, no-store")
            .type(evidence.mime)
            .send(evidence.data);
        },
      );
      routes.get(
        "/procedure-schedules",
        spec("list_procedure_schedules", "List schedule, webhook and watcher triggers"),
        async (request) => ({ schedules: workflows.listSchedules(actor(request)) }),
      );
      routes.post(
        "/procedure-schedules",
        spec("create_procedure_schedule", "Create a pinned procedure trigger", ScheduleInputSchema),
        async (request) => workflows.putSchedule(request.body, actor(request)),
      );
      routes.put(
        "/procedure-schedules/:id",
        spec(
          "update_procedure_schedule",
          "Update a trigger; webhook updates rotate its secret",
          ScheduleInputSchema,
        ),
        async (request) =>
          workflows.putSchedule({ ...(request.body as object), id: id(request) }, actor(request)),
      );
      routes.delete(
        "/procedure-schedules/:id",
        spec("delete_procedure_schedule", "Delete a trigger without cancelling existing runs"),
        async (request) => {
          await workflows.removeSchedule(id(request), actor(request));
          return { deleted: true };
        },
      );
      routes.get(
        "/procedure-schedules/:id/history",
        spec("procedure_schedule_history", "Read trigger delivery and deadline history"),
        async (request) => ({
          history: await workflows.scheduleHistory(id(request), actor(request)),
        }),
      );
      routes.post(
        "/procedure-triggers/:id",
        spec("trigger_procedure_webhook", "Deliver an authenticated idempotent procedure webhook"),
        async (request) => {
          const token = request.headers["x-steel-webhook-token"];
          const event = request.headers["idempotency-key"];
          if (typeof token !== "string" || typeof event !== "string")
            throw new WorkflowError(
              "webhook_credentials_required",
              "X-Steel-Webhook-Token and Idempotency-Key are required",
              401,
            );
          return workflows.webhook(id(request), token, event);
        },
      );
      routes.get(
        "/regression-replays",
        spec("list_regression_replays", "Compare candidate procedure runs with verified baselines"),
        async (request) => ({ replays: await workflows.listReplays(actor(request)) }),
      );
      routes.post(
        "/regression-replays",
        spec(
          "start_regression_replay",
          "Replay a baseline in a fresh browser restricted to owned fixtures",
          ReplayInputSchema,
        ),
        async (request) => workflows.startReplay(request.body, actor(request)),
      );
      routes.get(
        "/regression-replays/:id",
        spec("get_regression_replay", "Read assertion differences and observed runtime version"),
        async (request) => workflows.getReplay(id(request), actor(request)),
      );
    },
    { prefix: "/v1" },
  );
  server.addHook("onReady", () => workflows.initialize());
  server.addHook("preClose", () => workflows.close());
};
export default fp(plugin, { name: "steel-workflows", dependencies: ["steel-platform"] });
