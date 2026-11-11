import { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { Duplex } from "stream";
import { WebSocketServer } from "ws";
import { WebSocketRegistryService } from "../../services/websocket-registry.service.js";
import { WebSocketHandler, WebSocketHandlerContext } from "../../types/websocket.js";
import { env } from "../../env.js";
import { scopedCdpEndpoint } from "../../services/control/devtools.js";
import { guardedCdp } from "../../services/control/socket.js";
import { observeCdpActivity } from "../../services/session-activity.js";
import { defaultHandlers } from "./handlers/index.js";

export interface BrowserSocketOptions {
  customHandlers?: WebSocketHandler[];
}

// WebSocket server instance
const wss = new WebSocketServer({ noServer: true });

const SCOPED_SOCKET = /^\/v1\/sessions\/([^/]+)\/(cdp|cast|logs|pageId|recording)\/?$/;

/**
 * The session whose access rules guard a browser socket. A scoped socket names
 * its session. The unscoped one is the primary browser's, so it belongs to the
 * session living in that browser, not to the newest live session: with several
 * sessions live those differ, and the owner's own control token was refused.
 */
export function socketResourceId(
  session: { id: string } | undefined,
  sessions:
    | {
        listSessions(): { id: string; cdpService?: unknown }[];
        activeSession: { id: string };
      }
    | undefined,
  primaryCdp: unknown,
): string | undefined {
  if (session) return session.id;
  const owner = sessions?.listSessions().find((s) => s.cdpService === primaryCdp);
  return owner?.id ?? sessions?.activeSession.id;
}

function rejectUpgrade(socket: Duplex, status: string) {
  if (!socket.destroyed && socket.writable) {
    try {
      socket.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`, () =>
        socket.destroy(),
      );
      setTimeout(() => socket.destroy(), 1000).unref();
    } catch {
      socket.destroy();
    }
  } else {
    socket.destroy();
  }
}

// The Host header and request-target are client-controlled, so never let them throw here.
export function parseUpgradeParams(url: string): Record<string, string> | null {
  try {
    return Object.fromEntries(new URL(url || "", "http://localhost").searchParams.entries());
  } catch {
    return null;
  }
}

const browserWebSocket: FastifyPluginAsync<BrowserSocketOptions> = async (
  fastify: FastifyInstance,
  options: BrowserSocketOptions,
) => {
  if (!fastify.cdpService.isRunning()) {
    fastify.log.info("Launching browser...");
    await fastify.cdpService.launch();
    fastify.log.info("Browser launched successfully");
  }

  const registry = new WebSocketRegistryService();

  defaultHandlers.forEach((handler) => {
    registry.registerHandler(handler);
  });

  if (options.customHandlers) {
    options.customHandlers.forEach((handler) => {
      registry.registerHandler(handler);
    });
  }

  fastify.decorate("webSocketRegistry", registry);

  fastify.server.on("upgrade", async (request, socket, head) => {
    socket.on("error", (err) => fastify.log.debug({ err }, "Upgrade socket error"));
    try {
      const url = request.url ?? "";
      const params = parseUpgradeParams(url);
      if (!params) {
        fastify.log.warn(
          { path: url.split("?", 1)[0].slice(0, 200) },
          "Rejecting invalid upgrade target",
        );
        if (!socket.destroyed && socket.writable) {
          try {
            socket.end(
              "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
              () => socket.destroy(),
            );
            // Ensure the socket cannot linger if the peer never reads the 400.
            setTimeout(() => socket.destroy(), 1000).unref();
          } catch {
            socket.destroy();
          }
        } else {
          socket.destroy();
        }
        return;
      }
      fastify.log.info("Upgrading browser socket...");

      // Session-scoped sockets: /v1/sessions/<id>/{cdp,cast,logs,pageId,recording},
      // or the unscoped paths with ?sessionId=<id>. Anything else goes to the
      // primary browser, as in single-session Steel.
      const pathname = url.split("?", 1)[0];
      const scoped = SCOPED_SOCKET.exec(pathname);
      const sessionId = scoped?.[1] ?? params.sessionId;
      const session = sessionId ? fastify.sessionService.findSocketSession(sessionId) : undefined;
      if (sessionId && fastify.sessionService.isParked(sessionId)) {
        rejectUpgrade(socket, "409 Conflict");
        return;
      }
      if (sessionId && !session) {
        fastify.log.warn({ sessionId }, "Rejecting socket for unknown session");
        rejectUpgrade(socket, "404 Not Found");
        return;
      }

      const resourceId = socketResourceId(session, fastify.sessionService, fastify.cdpService);
      let credential:
        | import("../../services/control/ownership.js").ConnectionCredential
        | undefined;
      if (fastify.access && resourceId) {
        const channel = scoped?.[2] === "cast" || pathname.endsWith("/cast") ? "cast" : "cdp";
        try {
          if (params.controlTicket)
            credential = fastify.control.consumeTicket(params.controlTicket, resourceId, channel);
          const actor = credential?.actor ?? fastify.access.authenticate(request);
          fastify.access.assertRead(actor, resourceId);
          const token = request.headers["x-steel-control"];
          if (!credential && typeof token === "string") {
            fastify.control.assert(resourceId, actor, token);
            credential = {
              sessionId: resourceId,
              actor,
              token,
              generation: fastify.control.get(resourceId)!.generation,
            };
          }
        } catch {
          rejectUpgrade(socket, "403 Forbidden");
          return;
        }
      }
      const assertControl = () => {
        if (fastify.control) {
          if (!credential || credential.observer)
            throw new Error("Current browser control is required");
          fastify.control.assertConnection(credential);
        }
      };
      const context: WebSocketHandlerContext = {
        assertControl,
        fastify,
        wss,
        params,
        session,
        cdpService: session?.cdpService ?? fastify.cdpService,
      };

      const attachActivity = () => {
        const owner =
          session ??
          fastify.sessionService?.listSessions().find((s) => s.cdpService === context.cdpService);
        if (owner?.status === "live")
          observeCdpActivity(
            socket,
            head,
            () => fastify.sessionService.touch(owner.id, "cdp"),
            env.IDLE_IGNORED_CDP_METHODS,
          );
      };
      if (scoped?.[2] === "cdp") {
        attachActivity();
        fastify.log.info({ sessionId }, "Connecting to session CDP...");
        try {
          if (fastify.control)
            await guardedCdp(
              request,
              socket,
              head,
              wss,
              await scopedCdpEndpoint(context.cdpService, params.pageId),
              fastify.control,
              credential,
            );
          else await context.cdpService.proxyWebSocket(request, socket, head);
        } catch (err) {
          fastify.log.error({ err }, "CDP WebSocket error");
          socket.destroy();
        }
        return;
      }

      const handler = scoped
        ? registry.getHandler(`/v1/sessions/${scoped[2]}`)
        : registry.matchHandler(url);

      if (handler) {
        try {
          const readOnlyHandler = ["cast", "logs", "recording", "pageId"].includes(
            scoped?.[2] ?? pathname.split("/").pop() ?? "",
          );
          if (fastify.control && !readOnlyHandler) assertControl();
          await handler.handler(request, socket, head, context);
        } catch (err) {
          fastify.log.error({ err }, `WebSocket handler error for ${pathname}`);
          socket.destroy();
        }
      } else {
        attachActivity();
        fastify.log.info("Connecting to CDP...");
        try {
          if (fastify.control)
            await guardedCdp(
              request,
              socket,
              head,
              wss,
              context.cdpService.getWsEndpoint()!,
              fastify.control,
              credential,
            );
          else await context.cdpService.proxyWebSocket(request, socket, head);
        } catch (err) {
          fastify.log.error({ err }, "CDP WebSocket error");
          socket.destroy();
        }
      }
    } catch (err) {
      fastify.log.error({ err }, "Unexpected upgrade handler error");
      // Never socket.end here: a 101 may already be half-written, so destroy only.
      if (!socket.destroyed) {
        try {
          socket.destroy();
        } catch (destroyErr) {
          fastify.log.debug({ err: destroyErr }, "Failed to destroy upgrade socket");
        }
      }
    }
  });
};

export default fp(browserWebSocket, { name: "browser-websocket" });
