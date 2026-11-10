import { randomUUID } from "node:crypto";
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
  server.get<{
    Params: { id: string };
    Querystring: { controlTicket: string; pageId?: string; websocketPath?: string };
  }>(
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
            websocketPath: { type: "string", maxLength: 1024 },
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
        const socketPath = request.query.websocketPath;
        const suffix = `/v1/sessions/${encodeURIComponent(id)}/cdp`;
        if (
          socketPath &&
          (!socketPath.startsWith("/") ||
            socketPath.startsWith("//") ||
            /[\\%?#]/.test(socketPath) ||
            !socketPath.endsWith(suffix))
        )
          throw new AccessError(
            "invalid_socket_path",
            "DevTools requires a same-origin scoped websocket path",
            400,
          );
        const nonce = randomUUID();
        const config = JSON.stringify({
          id,
          pageId,
          ticket: request.query.controlTicket,
          socketPath,
        }).replace(/</g, "\\u003c");
        const script = `const config=${config};const socket=new URL(location.href);socket.protocol=location.protocol==='https:'?'wss:':'ws:';socket.pathname=config.socketPath||location.pathname.replace(/\\/devtools$/,'/cdp').replace(/^\\/api\\//,'/ws/');socket.search='';socket.hash='';socket.searchParams.set('pageId',config.pageId);socket.searchParams.set('controlTicket',config.ticket);const target=new URL('devtools/inspector.html',location.href);target.search='';target.hash='';target.searchParams.set(socket.protocol==='wss:'?'wss':'ws',socket.toString().replace(/^wss?:\\/\\//,''));location.replace(target.toString());`;
        return reply
          .header("referrer-policy", "no-referrer")
          .header("cache-control", "no-store")
          .header(
            "content-security-policy",
            `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'`,
          )
          .type("text/html; charset=utf-8")
          .send(
            `<!doctype html><meta charset="utf-8"><title>Opening DevTools</title><script nonce="${nonce}">${script}</script>`,
          );
      } catch (error) {
        if (error instanceof AccessError)
          return reply
            .code(error.statusCode)
            .send({ success: false, code: error.code, message: error.message });
        throw error;
      }
    },
  );
  server.get<{ Params: { id: string; "*": string }; Querystring: { ws?: string; wss?: string } }>(
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
          let allowed = new URL(getSessionUrl(session.id, "cdp", "ws")).origin;
          const frontendSocket = request.query.wss ?? request.query.ws;
          if (frontendSocket) {
            try {
              allowed = new URL(
                `${request.query.wss ? "wss" : "ws"}://${frontendSocket.replace(/^\/\//, "")}`,
              ).origin;
            } catch {
              throw new AccessError("invalid_socket_path", "Invalid frontend socket", 400);
            }
          }
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
        return reply.code(502).send({
          success: false,
          code: "devtools_unavailable",
          message: "Browser frontend asset is unavailable",
        });
      }
    },
  );
}
