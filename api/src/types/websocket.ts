import { IncomingMessage } from "http";
import { Duplex } from "stream";
import { WebSocketServer } from "ws";
import { FastifyInstance } from "fastify";
import type { CDPService } from "../services/cdp/cdp.service.js";
import type { Session } from "../services/session.service.js";

export interface WebSocketHandlerContext {
  assertControl?: () => void;
  fastify: FastifyInstance;
  wss: WebSocketServer;
  params: Record<string, string>;
  /** The session the socket is scoped to (path /v1/sessions/<id>/... or ?sessionId=). */
  session?: Session;
  /** The browser to attach to: the session's, or the primary browser when unscoped. */
  cdpService: CDPService;
}

export interface WebSocketHandler {
  path: string;
  handler: (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    context: WebSocketHandlerContext,
  ) => Promise<void> | void;
}

export interface WebSocketHandlerRegistry {
  handlers: Map<string, WebSocketHandler>;
  registerHandler: (handler: WebSocketHandler) => void;
  getHandler: (path: string) => WebSocketHandler | undefined;
  matchHandler: (url: string) => WebSocketHandler | undefined;
}
