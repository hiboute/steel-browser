import type { FastifyInstance } from "fastify";
import { AccessError } from "../../services/control/access.js";
import { readDevtoolsAsset, scopedCdpEndpoint } from "../../services/control/devtools.js";
import { getSessionUrl } from "../../utils/url.js";

export default async function devtoolsRoutes(server: FastifyInstance) {
  const params = {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", minLength: 1, maxLength: 128 } },
  } as const;
  server.get<{ Params: { id: string }; Querystring: { controlTicket: string; pageId?: string } }>(
    "/sessions/:id/devtools",
    {
      schema: {
        operationId: "open_scoped_devtools",
        tags: ["CDP"],
        params,
        querystring: {
          type: "object",
          required: ["controlTicket"],
          properties: {
            controlTicket: { type: "string", minLength: 1, maxLength: 128 },
            pageId: { type: "string", maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params;
        server.access.authorizeSession(request, id);
        const credential = server.control.inspectTicket(request.query.controlTicket, id, "cdp");
        if (credential.observer)
          throw new AccessError(
            "control_required",
            "DevTools requires explicit browser control",
            409,
          );
        const session = server.sessionService.getSession(id);
        if (!session || session.status !== "live")
          throw new AccessError(
            "session_not_live",
            "Resume the browser before opening DevTools",
            409,
          );
        const pages = await session.cdpService.getAllPages();
        const pageId =
          request.query.pageId ?? (pages[0] && session.cdpService.getTargetId(pages[0]));
        if (!pageId)
          throw new AccessError("page_not_found", "No page is available for inspection", 404);
        await scopedCdpEndpoint(session.cdpService, pageId);
        const socket = new URL(getSessionUrl(id, "cdp", "ws"));
        socket.searchParams.set("pageId", pageId);
        socket.searchParams.set("controlTicket", request.query.controlTicket);
        const query = new URLSearchParams({
          [socket.protocol === "wss:" ? "wss" : "ws"]: socket.toString().replace(/^wss?:\/\//, ""),
        });
        return reply
          .header("referrer-policy", "no-referrer")
          .header("cache-control", "no-store")
          .redirect(`/v1/sessions/${encodeURIComponent(id)}/devtools/inspector.html?${query}`);
      } catch (error) {
        if (error instanceof AccessError)
          return reply
            .code(error.statusCode)
            .send({ success: false, code: error.code, message: error.message });
        throw error;
      }
    },
  );
  server.get<{ Params: { id: string; "*": string } }>(
    "/sessions/:id/devtools/*",
    { schema: { operationId: "get_scoped_devtools_asset", tags: ["CDP"], hide: true } },
    async (request, reply) => {
      try {
        server.access.authorizeSession(request, request.params.id);
        const session = server.sessionService.getSession(request.params.id);
        if (!session || session.status !== "live")
          throw new AccessError("session_not_live", "Browser is unavailable", 409);
        const endpoint = session.cdpService.getWsEndpoint();
        if (!endpoint)
          throw new AccessError("session_not_live", "Browser transport is unavailable", 409);
        const asset = await readDevtoolsAsset(endpoint, request.params["*"]);
        let body = asset.body;
        if (asset.type.startsWith("text/html")) {
          const allowed = new URL(getSessionUrl(session.id, "cdp", "ws")).origin;
          body = Buffer.from(
            body
              .toString()
              .replace(
                /connect-src ([^;]*);/g,
                (_all, current) => `connect-src ${current} ${allowed};`,
              ),
          );
        }
        return reply
          .code(asset.status)
          .header("referrer-policy", "no-referrer")
          .header("cache-control", "no-store")
          .type(asset.type)
          .send(body);
      } catch (error) {
        if (error instanceof AccessError)
          return reply
            .code(error.statusCode)
            .send({ success: false, code: error.code, message: error.message });
        server.log.warn({ sessionId: request.params.id }, "DevTools asset unavailable");
        return reply
          .code(502)
          .send({
            success: false,
            code: "devtools_unavailable",
            message: "Browser frontend asset is unavailable",
          });
      }
    },
  );
}
