import type { FastifyInstance } from "fastify";
import type { TimelineInput } from "../../services/timeline.service.js";
import { AgentFeatureError } from "../../services/handoff/agent-feature-utils.js";
import { $ref } from "../handoff/agent-features.schema.js";
import { caller, errorResponses, featureErrors, featureReply } from "../handoff/handoff.routes.js";

export default async function timelineRoutes(server: FastifyInstance) {
  featureErrors(server);
  server.post<{ Params: { id: string }; Body: TimelineInput }>(
    "/sessions/:id/timeline",
    {
      schema: {
        tags: ["Timeline"],
        operationId: "append_session_timeline",
        summary: "Record an agent action and optional screenshot",
        params: $ref("AgentSessionParams"),
        body: $ref("PostTimeline"),
        response: { 200: $ref("TimelineEntry"), ...errorResponses },
      },
    },
    (request, reply) =>
      featureReply(reply, async () => {
        const id = request.params.id;
        if (
          !server.sessionService.getSession(id) &&
          !server.sessionService.pastSessions.some((session) => session.id === id)
        ) {
          throw new AgentFeatureError(404, "session_not_found", "Session not found");
        }
        server.sessionService.touch(id, "timeline");
        const release = server.sessionService.holdActivity(id);
        try {
          return await server.timeline.append(id, request.body, caller(request));
        } finally {
          release();
        }
      }),
  );

  server.get<{ Params: { id: string }; Querystring: { after?: number; limit?: number } }>(
    "/sessions/:id/timeline",
    {
      schema: {
        tags: ["Timeline"],
        operationId: "get_session_timeline",
        summary: "Read retained session actions",
        params: $ref("AgentSessionParams"),
        querystring: $ref("TimelineQuery"),
        response: { 200: $ref("TimelineResponse"), ...errorResponses },
      },
    },
    (request, reply) =>
      featureReply(reply, async () => ({
        entries: await server.timeline.read(
          request.params.id,
          request.query.after,
          request.query.limit,
        ),
      })),
  );

  server.get<{ Params: { id: string; seq: number } }>(
    "/sessions/:id/timeline/:seq/screenshot",
    {
      schema: {
        tags: ["Timeline"],
        operationId: "get_timeline_screenshot",
        summary: "Read an action screenshot",
        params: $ref("AgentFrameParams"),
        response: { 200: { type: "string", format: "binary" }, ...errorResponses },
      },
    },
    (request, reply) =>
      featureReply(reply, async () => {
        const image = await server.timeline.image(request.params.id, request.params.seq);
        return reply
          .header("Cache-Control", "private, max-age=3600")
          .type("image/jpeg")
          .send(image);
      }),
  );
}
