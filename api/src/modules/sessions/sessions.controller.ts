import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getErrors } from "../../utils/errors.js";
import { CreateSessionRequest, SessionDetails, SessionStreamRequest } from "./sessions.schema.js";
import { CookieData } from "../../services/context/types.js";
import { getUrl, getBaseUrl, getSessionUrl } from "../../utils/url.js";
import { SessionPoolFullError, type Session } from "../../services/session.service.js";

export const handleLaunchBrowserSession = async (
  server: FastifyInstance,
  request: CreateSessionRequest,
  reply: FastifyReply,
) => {
  try {
    const {
      sessionId,
      proxyUrl,
      userDataDir,
      persist,
      userAgent,
      sessionContext,
      extensions,
      logSinkUrl,
      timezone,
      dimensions,
      isSelenium,
      blockAds,
      optimizeBandwidth,
      extra,
      credentials,
      skipFingerprintInjection,
      userPreferences,
      deviceConfig,
      headless,
    } = request.body;

    return await server.sessionService.startSession({
      sessionId,
      proxyUrl,
      userDataDir,
      persist,
      userAgent,
      sessionContext: sessionContext as {
        cookies?: CookieData[] | undefined;
        localStorage?: Record<string, Record<string, any>> | undefined;
      },
      extensions,
      logSinkUrl,
      timezone,
      dimensions,
      isSelenium,
      blockAds,
      optimizeBandwidth,
      extra,
      credentials,
      skipFingerprintInjection,
      userPreferences,
      deviceConfig,
      headless,
    });
  } catch (e: unknown) {
    server.log.error({ err: e }, "Failed lauching browser session");
    const error = getErrors(e);
    const status = e instanceof SessionPoolFullError ? 429 : 500;
    return reply.code(status).send({ success: false, message: error });
  }
};

export const handleExitBrowserSession = async (
  server: FastifyInstance,
  request: FastifyRequest<{ Params: { sessionId?: string } }>,
  reply: FastifyReply,
) => {
  const sessionId = request.params?.sessionId;
  try {
    if (!sessionId) {
      // POST /v1/sessions/release: release everything that is live.
      const released = await server.sessionService.endAllSessions();
      const last = released[released.length - 1] ?? server.sessionService.activeSession;
      return reply.send({ success: true, ...last });
    }
    if (!server.sessionService.getSession(sessionId)) {
      const past = server.sessionService.pastSessions.find((s) => s.id === sessionId);
      if (past) return reply.send({ success: true, ...past });
      return reply.code(404).send({ success: false, message: `Session ${sessionId} not found` });
    }
    const sessionDetails = await server.sessionService.endSession(sessionId);
    return reply.send({ success: true, ...sessionDetails });
  } catch (e: any) {
    const error = getErrors(e);
    return reply.code(500).send({ success: false, message: error });
  }
};

export const handleGetBrowserContext = async (
  server: FastifyInstance,
  request: FastifyRequest<{ Params: { sessionId: string } }>,
  reply: FastifyReply,
) => {
  const session = server.sessionService.getSession(request.params.sessionId);
  const context = await (session?.cdpService ?? server.cdpService).getBrowserState();
  return reply.send(context);
};

/** Strips the server-side fields that must not be serialized. */
function publicSession(session: Session): SessionDetails {
  const { completion, complete, proxyServer, cdpService, ...details } = session;
  return {
    ...details,
    duration:
      session.status === "live"
        ? new Date().getTime() - new Date(session.createdAt).getTime()
        : session.duration,
  } as SessionDetails;
}

export const handleGetSessionDetails = async (
  server: FastifyInstance,
  request: FastifyRequest<{ Params: { sessionId: string } }>,
  reply: FastifyReply,
) => {
  const sessionId = request.params.sessionId;
  const session =
    server.sessionService.getSession(sessionId) ??
    server.sessionService.pastSessions.find((s) => s.id === sessionId);
  if (session) {
    return reply.send(publicSession(session));
  }
  return reply.send({
    id: sessionId,
    createdAt: new Date().toISOString(),
    status: "released",
    duration: 0,
    eventCount: 0,
    timeout: 0,
    creditsUsed: 0,
    websocketUrl: getBaseUrl("ws"),
    debugUrl: getUrl("v1/sessions/debug"),
    debuggerUrl: getUrl("v1/devtools/inspector.html"),
    sessionViewerUrl: getBaseUrl(),
    userAgent: "",
    isSelenium: false,
    proxy: "",
    proxyTxBytes: 0,
    proxyRxBytes: 0,
    solveCaptcha: false,
  } as SessionDetails);
};

export const handleGetSessions = async (
  server: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  // Live sessions first, newest first; then the idle browser if nothing is live;
  // then released ones, newest first.
  const live = server.sessionService.listSessions().reverse();
  const current = live.length > 0 ? live : [server.sessionService.activeSession];
  const past = [...server.sessionService.pastSessions].reverse();
  return reply.send({ sessions: [...current, ...past].map(publicSession) });
};

export const handleGetSessionStream = async (
  server: FastifyInstance,
  request: SessionStreamRequest,
  reply: FastifyReply,
) => {
  const { showControls, theme, interactive, pageId, pageIndex } = request.query;
  const sessionId = (request.params as { sessionId?: string } | undefined)?.sessionId;
  const session = sessionId
    ? server.sessionService.getSession(sessionId)
    : server.sessionService.activeSession;
  if (!session) {
    return reply.code(404).send({ success: false, message: `Session ${sessionId} not found` });
  }

  const singlePageMode = !!(pageId || pageIndex);

  // Construct WebSocket URL with page parameters if present
  let wsUrl =
    session.status === "live"
      ? getSessionUrl(session.id, "cast", "ws")
      : getUrl("v1/sessions/cast", "ws");
  if (pageId) {
    wsUrl += `?pageId=${encodeURIComponent(pageId)}`;
  } else if (pageIndex) {
    wsUrl += `?pageIndex=${encodeURIComponent(pageIndex)}`;
  }

  return reply.view("live-session-streamer.ejs", {
    wsUrl,
    showControls,
    theme,
    interactive,
    dimensions: session.dimensions,
    singlePageMode,
  });
};

export const handleGetSessionLiveDetails = async (
  server: FastifyInstance,
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) => {
  const session =
    server.sessionService.getSession(request.params.id) ?? server.sessionService.activeSession;
  const cdpService = session.cdpService ?? server.cdpService;
  try {
    const pages = await cdpService.getAllPages();

    const pagesInfo = await Promise.all(
      pages.map(async (page) => {
        try {
          const pageId = page.target()._targetId;

          const title = await page.title();

          let favicon: string | null = null;
          try {
            favicon = await page.evaluate(() => {
              const iconLink = document.querySelector(
                'link[rel="icon"], link[rel="shortcut icon"]',
              );
              if (iconLink) {
                const href = iconLink.getAttribute("href");
                if (href?.startsWith("http")) return href;
                if (href?.startsWith("//")) return window.location.protocol + href;
                if (href?.startsWith("/")) return window.location.origin + href;
                return window.location.origin + "/" + href;
              }
              return null;
            });
          } catch (error) {}

          return {
            id: pageId,
            url: page.url(),
            title,
            favicon,
          };
        } catch (error) {
          console.error("Error collecting page info:", error);
          return null;
        }
      }),
    );

    const validPagesInfo = pagesInfo.filter((page) => page !== null);

    const browserVersion = await cdpService.getBrowserState();

    const browserState = {
      status: session.status,
      userAgent: session.userAgent,
      browserVersion,
      initialDimensions: session.dimensions || {
        width: 1920,
        height: 1080,
      },
      pageCount: validPagesInfo.length,
    };

    return reply.send({
      pages: validPagesInfo,
      browserState,
      websocketUrl: session.websocketUrl,
      sessionViewerUrl: session.sessionViewerUrl,
      sessionViewerFullscreenUrl: `${session.sessionViewerUrl}?showControls=false`,
    });
  } catch (error) {
    console.error("Error getting session state:", error);
    return reply.code(500).send({
      message: "Failed to get session state",
      error: getErrors(error),
    });
  }
};
