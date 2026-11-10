import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { $ref } from "../../plugins/schemas.js";
import cdpSchemas from "./cdp.schemas.js";

async function routes(server: FastifyInstance) {
  server.get(
    "/devtools/inspector.html",
    {
      schema: {
        operationId: "getDevtoolsUrl",
        description: "Get the URL for the DevTools inspector",
        tags: ["CDP"],
        summary: "Get the URL for the DevTools inspector",
        querystring: $ref("GetDevtoolsUrlSchema"),
      },
    },
    async (
      request: FastifyRequest<{ Querystring: z.infer<typeof cdpSchemas.GetDevtoolsUrlSchema> }>,
      reply: FastifyReply,
    ) => {
      // The legacy raw-browser DevTools URL bypasses per-session control fencing.
      // Interactive inspection uses the authenticated scoped viewer instead.
      const session = server.sessionService.activeSession;
      server.access?.authorizeSession(request, session.id);
      return reply.redirect(`/v1/sessions/${encodeURIComponent(session.id)}/debug`);
    },
  );
}

export default routes;
