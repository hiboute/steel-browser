import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Handoff, HandoffRequest } from "../../services/handoff.service.js";
import { AgentFeatureError } from "../../services/handoff/agent-feature-utils.js";
import { $ref } from "./agent-features.schema.js";

export function caller(request: FastifyRequest): string {
  const value =
    (request as FastifyRequest & { steelClient?: string }).steelClient ??
    request.headers["x-steel-client"];
  return typeof value === "string" ? value.slice(0, 128) : "anonymous";
}

export async function featureReply<T>(
  reply: FastifyReply,
  operation: () => Promise<T>,
): Promise<T | FastifyReply> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof AgentFeatureError)) throw error;
    return reply
      .code(error.statusCode)
      .send({ success: false, code: error.code, message: error.message });
  }
}

export const errorResponses = {
  400: $ref("AgentFeatureError"),
  404: $ref("AgentFeatureError"),
  409: $ref("AgentFeatureError"),
};

export function featureErrors(server: FastifyInstance) {
  server.setErrorHandler((error: FastifyError, _request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) server.log.error({ err: error }, "Agent feature request failed");
    return reply.code(status).send({
      success: false,
      code: error.validation ? "invalid_request" : error.code ?? "internal_error",
      message: status >= 500 ? "The browser operation failed" : error.message,
    });
  });
}

export default async function handoffRoutes(server: FastifyInstance) {
  featureErrors(server);
  server.post<{ Params: { id: string }; Body: HandoffRequest }>(
    "/sessions/:id/handoff",
    {
      schema: {
        tags: ["Handoff"],
        operationId: "request_human_handoff",
        summary: "Ask a human to take over a live session",
        params: $ref("AgentSessionParams"),
        body: $ref("CreateHandoff"),
        response: { 200: $ref("HandoffRecord"), ...errorResponses },
      },
    },
    (request, reply) =>
      featureReply(reply, async () => {
        server.sessionService.touch(request.params.id, "handoff");
        const release = server.sessionService.holdActivity(request.params.id);
        try {
          return await server.handoffs.create(request.params.id, request.body, caller(request));
        } finally {
          release();
        }
      }),
  );

  server.get<{ Params: { id: string }; Querystring: { wait?: number } }>(
    "/sessions/:id/handoff",
    {
      schema: {
        tags: ["Handoff"],
        operationId: "get_human_handoff",
        summary: "Read or wait up to 50 seconds for a handoff",
        params: $ref("AgentSessionParams"),
        querystring: $ref("HandoffQuery"),
        response: { 200: $ref("HandoffRecord"), ...errorResponses },
      },
    },
    (request, reply) =>
      featureReply(reply, async () => {
        const abort = new AbortController();
        const onClose = () => {
          if (!reply.raw.writableFinished) abort.abort();
        };
        reply.raw.once("close", onClose);
        try {
          return await server.handoffs.wait(
            request.params.id,
            request.query.wait ?? 0,
            abort.signal,
          );
        } finally {
          reply.raw.off("close", onClose);
        }
      }),
  );

  for (const action of ["done", "cancel"] as const) {
    server.post<{ Params: { id: string }; Body?: { note?: string; declined?: boolean } }>(
      `/sessions/:id/handoff/${action}`,
      {
        schema: {
          tags: ["Handoff"],
          operationId: `${action}_human_handoff`,
          summary: `${action === "done" ? "Complete" : "Cancel"} a handoff`,
          params: $ref("AgentSessionParams"),
          body: $ref("ResolveHandoff"),
          response: { 200: $ref("HandoffRecord"), ...errorResponses },
        },
      },
      (request, reply) =>
        featureReply(reply, async () => {
          server.sessionService.touch(request.params.id, "handoff");
          return server.handoffs.resolve(
            request.params.id,
            action === "done" ? "done" : request.body?.declined ? "declined" : "cancelled",
            caller(request),
            request.body?.note,
          );
        }),
    );
  }

  server.get<{ Querystring: { status?: Handoff["status"] } }>(
    "/handoffs",
    {
      schema: {
        tags: ["Handoff"],
        operationId: "list_human_handoffs",
        summary: "List current and recent handoffs",
        querystring: $ref("HandoffsQuery"),
        response: { 200: $ref("HandoffsResponse") },
      },
    },
    async (request) => ({ handoffs: server.handoffs.list(request.query.status) }),
  );
}
