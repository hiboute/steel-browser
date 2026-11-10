import { IncomingMessage } from "http";
import { Duplex } from "stream";
import { WebSocketHandler, WebSocketHandlerContext } from "../../../types/websocket.js";
import { handleCastSession } from "../casting.handler.js";

export const castHandler: WebSocketHandler = {
  path: "/v1/sessions/cast",
  handler: async (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    context: WebSocketHandlerContext,
  ) => {
    context.fastify.log.info("Connecting to cast...");
    const session = context.session ?? context.fastify.sessionService.activeSession;
    await handleCastSession(request, socket, head, context.wss, session, context.params, () =>
      context.fastify.sessionService.touch(session.id, "cast"),
    );
  },
};
