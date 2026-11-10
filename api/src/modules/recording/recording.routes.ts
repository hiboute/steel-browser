import type { FastifyInstance } from "fastify";
import { $ref } from "../handoff/agent-features.schema.js";
import { errorResponses, featureErrors, featureReply } from "../handoff/handoff.routes.js";

export default async function recordingRoutes(server: FastifyInstance) {
  featureErrors(server);
  for (const action of ["start", "stop"] as const) {
    server.post<{ Params: { id: string } }>(
      `/sessions/:id/recording/${action}`,
      {
        schema: {
          tags: ["Recording"],
          operationId: `${action}_session_recording`,
          summary: `${action === "start" ? "Start" : "Stop"} session recording`,
          params: $ref("AgentSessionParams"),
          response: { 200: $ref("RecordingDetails"), ...errorResponses },
        },
      },
      (request, reply) =>
        featureReply(reply, async () => {
          server.sessionService.touch(request.params.id, "recording");
          const details = await server.recordings[action](request.params.id);
          const options = server.sessionService.getLaunchOptions(request.params.id);
          if (options) options.record = action === "start";
          return details;
        }),
    );
  }

  server.get<{ Params: { id: string } }>(
    "/sessions/:id/recording",
    {
      schema: {
        tags: ["Recording"],
        operationId: "get_session_recording",
        summary: "Get session recording status",
        params: $ref("AgentSessionParams"),
        response: { 200: $ref("RecordingDetails"), ...errorResponses },
      },
    },
    (request, reply) => featureReply(reply, async () => server.recordings.get(request.params.id)),
  );

  server.get<{
    Params: { id: string };
    Querystring: { from?: number; to?: number; limit?: number };
  }>(
    "/sessions/:id/recording/frames",
    {
      schema: {
        tags: ["Recording"],
        operationId: "get_recording_frames",
        summary: "Get frames in a recording time range (milliseconds)",
        params: $ref("AgentSessionParams"),
        querystring: $ref("RecordingFramesQuery"),
        response: { 200: $ref("RecordingFramesResponse"), ...errorResponses },
      },
    },
    (request, reply) =>
      featureReply(reply, async () => ({
        frames: await server.recordings.frames(
          request.params.id,
          request.query.from,
          request.query.to,
          request.query.limit,
        ),
      })),
  );

  server.get<{ Params: { id: string; seq: number } }>(
    "/sessions/:id/recording/frames/:seq",
    {
      schema: {
        tags: ["Recording"],
        operationId: "get_recording_frame",
        summary: "Read a recorded JPEG frame",
        params: $ref("AgentFrameParams"),
        response: { 200: { type: "string", format: "binary" }, ...errorResponses },
      },
    },
    (request, reply) =>
      featureReply(reply, async () =>
        reply
          .header("Cache-Control", "private, max-age=3600")
          .type("image/jpeg")
          .send(await server.recordings.image(request.params.id, request.params.seq)),
      ),
  );

  server.delete<{ Params: { id: string } }>(
    "/sessions/:id/recording",
    {
      schema: {
        tags: ["Recording"],
        operationId: "delete_session_recording",
        summary: "Delete a recording and its frames",
        params: $ref("AgentSessionParams"),
        response: { 200: $ref("AgentFeatureSuccess"), ...errorResponses },
      },
    },
    (request, reply) =>
      featureReply(reply, async () => {
        await server.recordings.remove(request.params.id);
        return { success: true as const };
      }),
  );

  server.get(
    "/recordings",
    {
      schema: {
        tags: ["Recording"],
        operationId: "list_recordings",
        summary: "List retained recordings",
        response: { 200: $ref("RecordingsResponse") },
      },
    },
    async () => ({ recordings: server.recordings.list() }),
  );
}
