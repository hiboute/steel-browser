import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { accessOf } from "../../services/workbench/adapters.js";
import { WorkbenchError } from "../../services/workbench/workbench.service.js";

const id = z.string().regex(/^[\w-]{1,100}$/);
const revision = z.string().min(1).max(200);
const step = z
  .object({
    seq: z.number().int().positive(),
    tool: z.string().min(1).max(100),
    args: z.unknown().optional(),
    title: z.string().max(500).optional(),
    replayable: z.boolean(),
  })
  .strict();
const knowledge = z
  .object({
    sessionId: id,
    handoffId: id,
    title: z.string().min(1).max(200),
    note: z.string().min(1).max(8000),
    selectedSteps: z.array(z.number().int().positive()).max(50),
    origin: z.url().max(2000),
    procedureId: id.optional(),
    visibility: z.enum(["private", "workspace"]).optional(),
    expiresInDays: z.number().int().min(1).max(365).optional(),
  })
  .strict();
const edit = z
  .object({
    expectedVersion: z.number().int().positive(),
    title: z.string().min(1).max(200).optional(),
    note: z.string().min(1).max(8000).optional(),
    disabled: z.boolean().optional(),
    expiresInDays: z.number().int().min(1).max(365).optional(),
    steps: z.array(step).max(50).optional(),
  })
  .strict();
const accept = z
  .object({
    expectedVersion: z.number().int().positive(),
    sessionId: id,
    accepted: z.literal(true),
    idempotencyKey: z.string().min(1).max(128),
  })
  .strict();
const action = z
  .object({
    expectedRevision: revision,
    action: z.enum(["answer", "retry", "approve", "reject"]),
    note: z.string().max(8000).optional(),
    resolution: z.string().max(2000).optional(),
    contentHash: z.string().max(128).optional(),
  })
  .strict();
const update = z
  .object({
    expectedRevision: revision,
    read: z.boolean().optional(),
    dismissed: z.boolean().optional(),
  })
  .strict()
  .refine(
    (v) => v.read !== undefined || v.dismissed !== undefined,
    "Choose read or dismissed state",
  );
const schema = (summary: string, body?: z.ZodType) => ({
  tags: ["Workbench"],
  summary,
  ...(body ? { body: z.toJSONSchema(body, { target: "draft-7", unrepresentable: "any" }) } : {}),
});
const actor = (server: FastifyInstance, request: FastifyRequest) => accessOf(server).actor(request);
const token = (request: FastifyRequest) =>
  typeof request.headers["x-steel-control"] === "string"
    ? request.headers["x-steel-control"]
    : undefined;

export default async function workbenchRoutes(server: FastifyInstance) {
  server.setErrorHandler((error, request, reply) => {
    if (error instanceof WorkbenchError)
      return reply.code(error.statusCode).send({ code: error.code, message: error.message });
    if (error instanceof z.ZodError)
      return reply
        .code(400)
        .send({
          code: "invalid_request",
          message: error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; "),
        });
    const problem = error as {
      statusCode?: number;
      code?: string;
      message: string;
      validation?: unknown;
    };
    const status = problem.statusCode ?? 500;
    if (status >= 500) request.log.error({ err: error }, "Workbench operation failed");
    return reply
      .code(status)
      .send({
        code: problem.validation ? "invalid_request" : problem.code ?? "workbench_failed",
        message: status >= 500 ? "The workbench operation could not complete" : problem.message,
      });
  });
  server.get<{ Querystring: { includeDismissed?: boolean; status?: string; limit?: number } }>(
    "/inbox",
    {
      schema: {
        ...schema("List accessible, deduplicated work items"),
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            includeDismissed: { type: "boolean", default: false },
            status: { type: "string", maxLength: 80 },
            limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
          },
        },
      },
    },
    async (request) => ({
      items: await server.workbench.inbox(actor(server, request), request.query),
      unavailable: server.workbench.unavailable(),
    }),
  );
  server.patch<{ Params: { id: string } }>(
    "/inbox/:id",
    { schema: schema("Mark a work item read or dismissed", update) },
    (request) =>
      server.workbench.updateCard(
        request.params.id,
        actor(server, request),
        update.parse(request.body),
      ),
  );
  server.post<{ Params: { id: string } }>(
    "/inbox/:id/actions",
    { schema: schema("Act on the current revision of a work item", action) },
    (request) =>
      server.workbench.act(request.params.id, actor(server, request), {
        ...action.parse(request.body),
        controlToken: token(request),
      }),
  );
  server.get<{ Params: { id: string } }>(
    "/sessions/:id/explanation",
    { schema: schema("Explain why a browser is waiting and what happens next") },
    (request) => server.workbench.explanation(request.params.id, actor(server, request)),
  );
  server.get<{ Querystring: { origin?: string; procedureId?: string; suggestions?: boolean } }>(
    "/recovery-knowledge",
    {
      schema: {
        ...schema("List learned site recovery knowledge"),
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            origin: { type: "string", maxLength: 2000 },
            procedureId: { type: "string", maxLength: 100 },
            suggestions: { type: "boolean", default: false },
          },
        },
      },
    },
    async (request) => ({
      knowledge: await server.workbench.listKnowledge(actor(server, request), request.query),
    }),
  );
  server.post(
    "/recovery-knowledge",
    { schema: schema("Save an explicitly selected human resolution", knowledge) },
    (request) =>
      server.workbench.createKnowledge(knowledge.parse(request.body), actor(server, request)),
  );
  server.get<{ Params: { id: string }; Querystring: { version?: number } }>(
    "/recovery-knowledge/:id",
    {
      schema: {
        ...schema("Read a recovery knowledge version"),
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { version: { type: "integer", minimum: 1 } },
        },
      },
    },
    (request) =>
      server.workbench.knowledge(request.params.id, actor(server, request), request.query.version),
  );
  server.put<{ Params: { id: string } }>(
    "/recovery-knowledge/:id",
    { schema: schema("Save a new immutable recovery knowledge version", edit) },
    (request) =>
      server.workbench.updateKnowledge(
        request.params.id,
        actor(server, request),
        edit.parse(request.body),
      ),
  );
  server.delete<{ Params: { id: string }; Querystring: { expectedVersion: number } }>(
    "/recovery-knowledge/:id",
    {
      schema: {
        ...schema("Delete recovery knowledge and its versions"),
        querystring: {
          type: "object",
          required: ["expectedVersion"],
          additionalProperties: false,
          properties: { expectedVersion: { type: "integer", minimum: 1 } },
        },
      },
    },
    (request) =>
      server.workbench.deleteKnowledge(
        request.params.id,
        actor(server, request),
        request.query.expectedVersion,
      ),
  );
  server.post<{ Params: { id: string } }>(
    "/recovery-knowledge/:id/accept",
    { schema: schema("Explicitly apply an exact reviewed recovery version", accept) },
    (request) =>
      server.workbench.acceptKnowledge(request.params.id, actor(server, request), {
        ...accept.parse(request.body),
        controlToken: token(request),
      }),
  );
}
