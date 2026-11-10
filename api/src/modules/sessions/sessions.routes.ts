import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  handleLaunchBrowserSession,
  handleGetBrowserContext,
  handleExitBrowserSession,
  handleGetSessionDetails,
  handleGetSessions,
  handleGetSessionStream,
  handleGetSessionLiveDetails,
} from "./sessions.controller.js";
import { handleScrape, handleScreenshot, handlePDF } from "../actions/actions.controller.js";
import { $ref } from "../../plugins/schemas.js";
import {
  CreateSessionRequest,
  RecordedEvents,
  SessionStreamRequest,
  SessionsScrapeRequest,
  SessionsScreenshotRequest,
  SessionsPDFRequest,
} from "./sessions.schema.js";
import { BrowserEventType, EmitEvent } from "../../types/enums.js";
import { quickAction } from "../commands/commands.guard.js";
import { SessionStateError, SessionPoolFullError } from "../../services/session.service.js";
import { PoolClosedError } from "../../services/browser-pool.service.js";
import { env } from "../../env.js";

async function routes(server: FastifyInstance) {
  const fail = (error: unknown, reply: FastifyReply) => {
    if (error instanceof SessionStateError)
      return reply
        .code(error.statusCode)
        .send({ success: false, code: error.code, message: error.message });
    if (error instanceof SessionPoolFullError) {
      const pool = server.sessionService.getPoolStatus();
      return reply
        .code(429)
        .header("Retry-After", "1")
        .send({
          success: false,
          code: error.code,
          message: error.message,
          pool: { max: pool.maxSessions, live: pool.live, queued: pool.queued },
        });
    }
    if (error instanceof PoolClosedError)
      return reply
        .code(503)
        .send({ success: false, code: "shutting_down", message: error.message });
    if (error instanceof Error && error.name === "BrowserProfileInUseError")
      return reply
        .code(409)
        .send({ success: false, code: "profile_in_use", message: error.message });
    throw error;
  };
  const sessionParams = {
    type: "object",
    required: ["sessionId"],
    properties: { sessionId: { type: "string", format: "uuid" } },
  } as const;
  server.post<{ Params: { sessionId: string } }>(
    "/sessions/:sessionId/touch",
    {
      schema: {
        operationId: "touch_session",
        tags: ["Sessions"],
        summary: "Mark a live session active",
        params: sessionParams,
        response: { 200: $ref("SessionDetails") },
      },
    },
    async (request, reply) => {
      if (server.sessionService.isParked(request.params.sessionId))
        return reply
          .code(409)
          .send({ success: false, code: "session_parked", message: "Session is parked" });
      const session = server.sessionService.touch(request.params.sessionId, "api");
      return (
        session ??
        reply
          .code(404)
          .send({ success: false, code: "session_not_found", message: "Session not found" })
      );
    },
  );
  server.patch<{ Params: { sessionId: string }; Body: Record<string, any> }>(
    "/sessions/:sessionId",
    {
      schema: {
        operationId: "update_session",
        tags: ["Sessions"],
        summary: "Update session settings",
        params: sessionParams,
        body: $ref("SessionSettings"),
        response: { 200: $ref("SessionDetails") },
      },
    },
    async (request, reply) => {
      try {
        return await server.sessionService.updateSession(request.params.sessionId, request.body);
      } catch (error) {
        return fail(error, reply);
      }
    },
  );
  server.post<{ Params: { sessionId: string }; Body?: { name?: string; reason?: "manual" } }>(
    "/sessions/:sessionId/park",
    {
      schema: {
        operationId: "park_session",
        tags: ["Sessions"],
        summary: "Park a session and free its browser slot",
        params: sessionParams,
        body: {
          type: "object",
          properties: {
            name: { type: "string", maxLength: 80 },
            reason: { type: "string", enum: ["manual"] },
          },
        },
        response: { 200: $ref("SessionDetails") },
      },
    },
    async (request, reply) => {
      try {
        return await server.sessionService.parkSession(
          request.params.sessionId,
          "manual",
          request.body?.name,
        );
      } catch (error) {
        return fail(error, reply);
      }
    },
  );
  server.post<{ Params: { sessionId: string }; Body?: { queueTimeout?: number } }>(
    "/sessions/:sessionId/resume",
    {
      schema: {
        operationId: "resume_session",
        tags: ["Sessions"],
        summary: "Resume a parked session with the same identity",
        params: sessionParams,
        body: {
          type: "object",
          properties: {
            queueTimeout: { type: "integer", minimum: 0, maximum: env.SESSION_QUEUE_MAX_MS },
          },
        },
        response: {
          200: $ref("SessionDetails"),
          429: $ref("PoolFullResponse"),
          503: $ref("PoolClosedResponse"),
        },
      },
    },
    async (request, reply) => {
      const abort = new AbortController();
      const cancel = () => {
        if (!reply.raw.writableFinished) abort.abort();
      };
      reply.raw.once("close", cancel);
      request.raw.once("aborted", cancel);
      if (request.raw.aborted) abort.abort();
      try {
        return await server.sessionService.resumeSession(request.params.sessionId, {
          queueTimeout: request.body?.queueTimeout,
          signal: abort.signal,
        });
      } catch (error) {
        if (abort.signal.aborted) return reply;
        return fail(error, reply);
      } finally {
        reply.raw.off("close", cancel);
        request.raw.off("aborted", cancel);
      }
    },
  );
  server.get<{ Params: { sessionId: string } }>(
    "/sessions/:sessionId/thumbnail",
    {
      schema: {
        operationId: "get_session_thumbnail",
        tags: ["Sessions"],
        summary: "Get a live or parked session thumbnail",
        params: sessionParams,
      },
    },
    async (request, reply) => {
      try {
        return reply
          .type("image/jpeg")
          .send(await server.sessionService.thumbnail(request.params.sessionId));
      } catch (error) {
        return fail(error, reply);
      }
    },
  );
  server.get<{ Params: { name: string } }>(
    "/sessions/by-name/:name",
    {
      schema: {
        operationId: "get_session_by_name",
        tags: ["Sessions"],
        summary: "Find a named session",
        response: { 200: $ref("SessionDetails") },
      },
    },
    async (request, reply) =>
      server.sessionService.listSessions(true).find((s) => s.name === request.params.name) ??
      reply
        .code(404)
        .send({ success: false, code: "session_not_found", message: "Session not found" }),
  );
  server.get(
    "/pool",
    {
      schema: {
        operationId: "get_pool_status",
        tags: ["Sessions"],
        summary: "Get browser slot and queue status",
        response: { 200: $ref("PoolStatus") },
      },
    },
    async () => server.sessionService.getPoolStatus(),
  );
  server.get(
    "/health",
    {
      schema: {
        operationId: "health",
        description: "Check if the server and browser are running",
        tags: ["Health"],
        summary: "Check if the server and browser are running",
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!server.cdpService.isRunning()) {
        return reply.status(503).send({ status: "service_unavailable" });
      }
      return reply.send({ status: "ok" });
    },
  );
  server.post(
    "/sessions",
    {
      schema: {
        operationId: "launch_browser_session",
        description: "Launch a browser session",
        tags: ["Sessions"],
        summary: "Launch a browser session",
        body: $ref("CreateSession"),
        response: {
          200: $ref("SessionDetails"),
          429: $ref("PoolFullResponse"),
          503: $ref("PoolClosedResponse"),
        },
      },
    },
    async (request: CreateSessionRequest, reply: FastifyReply) =>
      handleLaunchBrowserSession(server, request, reply),
  );

  server.get(
    "/sessions",
    {
      schema: {
        operationId: "get_sessions",
        description: "Get all sessions",
        tags: ["Sessions"],
        summary: "Get all sessions",
        querystring: {
          type: "object",
          properties: { include: { type: "string", enum: ["parked"] } },
        },
        response: {
          200: $ref("MultipleSessions"),
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: { include?: string } }>, reply: FastifyReply) =>
      handleGetSessions(server, request, reply),
  );

  server.get(
    "/sessions/:sessionId",
    {
      schema: {
        operationId: "get_session_details",
        description: "Get session details",
        tags: ["Sessions"],
        summary: "Get session details",
        response: {
          200: $ref("SessionDetails"),
        },
      },
    },
    async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply: FastifyReply) =>
      handleGetSessionDetails(server, request, reply),
  );

  server.get(
    "/sessions/:sessionId/context",
    {
      schema: {
        operationId: "get_browser_context",
        description: "Get a browser context",
        tags: ["Sessions"],
        summary: "Get a browser context",
        response: {
          200: $ref("SessionContextSchema"),
          404: $ref("SessionNotFoundResponse"),
        },
      },
    },
    async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply: FastifyReply) =>
      handleGetBrowserContext(server, request, reply),
  );

  server.post(
    "/sessions/:sessionId/release",
    {
      schema: {
        operationId: "release_browser_session",
        description: "Release a browser session",
        tags: ["Sessions"],
        summary: "Release a browser session",
        response: {
          200: $ref("ReleaseSession"),
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { sessionId?: string }; Body?: { sessionId?: unknown } }>,
      reply: FastifyReply,
    ) => handleExitBrowserSession(server, request, reply),
  );

  server.post(
    "/sessions/release",
    {
      schema: {
        operationId: "release_browser_sessions",
        description: "Release browser sessions",
        tags: ["Sessions"],
        summary: "Release browser sessions",
        body: $ref("ReleaseSessionsRequest"),
        response: {
          200: $ref("ReleaseSession"),
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { sessionId?: string }; Body?: { sessionId?: unknown } }>,
      reply: FastifyReply,
    ) => handleExitBrowserSession(server, request, reply),
  );

  server.get(
    "/sessions/debug",
    {
      onRequest: [],
      schema: {
        operationId: "get_session_debugger_stream",
        description: "Returns an HTML page with a live debugger view of the session",
        tags: ["Sessions"],
        summary: "Get session debugger view",
        querystring: $ref("SessionStreamQuery"),
        response: {
          200: $ref("SessionStreamResponse"),
        },
      },
    },
    async (request: SessionStreamRequest, reply: FastifyReply) =>
      handleGetSessionStream(server, request, reply),
  );

  server.get(
    "/sessions/:sessionId/debug",
    {
      onRequest: [],
      schema: {
        operationId: "get_session_debugger_stream_by_id",
        description: "Returns an HTML page with a live view of one session",
        tags: ["Sessions"],
        summary: "Get the live view of one session",
        querystring: $ref("SessionStreamQuery"),
        response: {
          200: $ref("SessionStreamResponse"),
        },
      },
    },
    async (request: SessionStreamRequest, reply: FastifyReply) =>
      handleGetSessionStream(server, request, reply),
  );

  server.post(
    "/events",
    {
      schema: {
        operationId: "receive_events",
        description: "Receive recorded events from the browser",
        tags: ["Sessions"],
        summary: "Receive recorded events from the browser",
        body: $ref("RecordedEvents"),
      },
    },
    async (request: FastifyRequest<{ Body: RecordedEvents }>, reply: FastifyReply) => {
      server.cdpService.getInstrumentationLogger().record({
        type: BrowserEventType.Recording,
        timestamp: new Date().toISOString(),
        data: request.body,
      });
      return reply.send({ status: "ok" });
    },
  );

  server.get(
    "/sessions/:id/live-details",
    {
      onRequest: [],
      schema: {
        operationId: "get_session_live_details",
        description:
          "Returns the live state of the session, including pages, tabs, and browser state",
        tags: ["Sessions"],
        summary: "Get session live details",
        response: {
          200: $ref("SessionLiveDetailsResponse"),
          404: $ref("SessionNotFoundResponse"),
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) =>
      handleGetSessionLiveDetails(server, request, reply),
  );

  server.post(
    "/sessions/scrape",
    {
      schema: {
        operationId: "scrape_session",
        description: "Scrape Current Session",
        tags: ["Sessions"],
        summary: "Scrape Current Session",
        body: $ref("ScrapeRequest"),
        response: {
          200: $ref("ScrapeResponse"),
        },
      },
    },
    async (request: SessionsScrapeRequest, reply: FastifyReply) =>
      quickAction(server, request, reply, () =>
        handleScrape(server.sessionService, server.cdpService, request, reply),
      ),
  );

  server.post(
    "/sessions/screenshot",
    {
      schema: {
        operationId: "screenshot_session",
        description: "Take Screenshot of Current Session",
        tags: ["Sessions"],
        summary: "Take Screenshot of Current Session",
        body: $ref("ScreenshotRequest"),
        response: {
          200: $ref("ScreenshotResponse"),
        },
      },
    },
    async (request: SessionsScreenshotRequest, reply: FastifyReply) =>
      quickAction(server, request, reply, () =>
        handleScreenshot(server.sessionService, server.cdpService, request, reply),
      ),
  );

  server.post(
    "/sessions/pdf",
    {
      schema: {
        operationId: "pdf_session",
        description: "Generate PDF of Current Session",
        tags: ["Sessions"],
        summary: "Generate PDF of Current Session",
        body: $ref("PDFRequest"),
        response: {
          200: $ref("PDFResponse"),
        },
      },
    },
    async (request: SessionsPDFRequest, reply: FastifyReply) =>
      quickAction(server, request, reply, () =>
        handlePDF(server.sessionService, server.cdpService, request, reply),
      ),
  );
}

export default routes;
