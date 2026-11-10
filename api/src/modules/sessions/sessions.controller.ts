import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AccessError } from "../../services/control/access.js";
import { getErrors } from "../../utils/errors.js";
import { CreateSessionRequest, SessionDetails, SessionStreamRequest } from "./sessions.schema.js";
import { CookieData } from "../../services/context/types.js";
import { getUrl, getBaseUrl, getSessionUrl } from "../../utils/url.js";
import {
  BrowserProfileInUseError,
  SessionStateError,
  SessionPoolFullError,
  type Session,
} from "../../services/session.service.js";
import {
  CookieSetNotFoundError,
  CookieSetDeniedError,
} from "../../services/cookie-library.service.js";
import { NordVpnError, nordVpnProxy } from "../../services/nordvpn.service.js";
import { PoolClosedError } from "../../services/browser-pool.service.js";

export const handleLaunchBrowserSession = async (
  server: FastifyInstance,
  request: CreateSessionRequest,
  reply: FastifyReply,
) => {
  const cancellation = new AbortController();
  const onAbort = () => cancellation.abort();
  const onClose = () => {
    if (!reply.raw.writableFinished) onAbort();
  };
  request.raw.once("aborted", onAbort);
  reply.raw.once("close", onClose);
  if (request.raw.aborted) onAbort();
  try {
    const {
      sessionId,
      name,
      labels,
      timeout,
      idleTimeout,
      keepAlive,
      onExpire,
      egress,
      record,
      cookieSetWriteBack,
      fingerprint,
      proxyUrl,
      userDataDir,
      persist,
      browserProfile,
      vpn,
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
      cookieSets,
      queueTimeout,
    } = request.body;

    let mergedContext = sessionContext as
      | {
          cookies?: CookieData[] | undefined;
          localStorage?: Record<string, Record<string, any>> | undefined;
        }
      | undefined;

    if ([proxyUrl, vpn, egress].filter((value) => value !== undefined).length > 1)
      throw new SessionStateError(
        "invalid_egress",
        "Pass only one of egress, vpn or proxyUrl",
        400,
      );
    let upstream = proxyUrl;
    let proxyLabel: string | undefined;
    if (vpn) {
      if (proxyUrl) throw new NordVpnError("Pass either proxyUrl or vpn, not both.");
      const nord = await nordVpnProxy(vpn.country);
      upstream = nord.url;
      proxyLabel = vpn.country ? `${nord.label} (${vpn.country.toUpperCase()})` : nord.label;
    }

    return await server.sessionService.startSession({
      _principal: request.steelPrincipal,
      identityProfile: request.body.identityProfile,
      compatibilityMode: request.body.compatibilityMode,
      siteProfile: request.body.siteProfile,
      mobileProfile: request.body.mobileProfile,
      continuityPolicy: request.body.continuityPolicy,
      continuityToken: request.body.continuityToken,
      frictionDetection: request.body.frictionDetection,
      egressPolicy: request.body.egressPolicy,
      siteScope: request.body.siteScope,
      name,
      labels,
      timeout,
      idleTimeout,
      keepAlive,
      onExpire,
      egress,
      record,
      cookieSets,
      cookieSetWriteBack,
      fingerprint,
      client: request.steelClient ?? "anonymous",
      queueTimeout,
      signal: cancellation.signal,
      sessionId,
      proxyUrl: upstream,
      proxyLabel,
      userDataDir,
      persist,
      browserProfile,
      userAgent,
      sessionContext: mergedContext,
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
    if (cancellation.signal.aborted) return reply;
    server.log.error({ err: e }, "Failed lauching browser session");
    const error = getErrors(e);
    if (e instanceof SessionPoolFullError) {
      const pool = server.sessionService.getPoolStatus();
      return reply
        .code(429)
        .header("Retry-After", "1")
        .send({
          success: false,
          code: e.code,
          message: error,
          pool: { max: pool.maxSessions, live: pool.live, queued: pool.queued },
        });
    }
    if (e instanceof AccessError)
      return reply.code(e.statusCode).send({ success: false, code: e.code, message: e.message });
    if (e instanceof SessionStateError)
      return reply.code(e.statusCode).send({ success: false, code: e.code, message: e.message });
    if (e instanceof CookieSetDeniedError)
      return reply
        .code(403)
        .send({ success: false, code: "cookie_set_denied", message: e.message });
    if (e instanceof PoolClosedError) {
      return reply.code(503).send({ success: false, code: "shutting_down", message: error });
    }
    const status =
      e instanceof BrowserProfileInUseError
        ? 409
        : e instanceof CookieSetNotFoundError || e instanceof NordVpnError
        ? 400
        : 500;
    return reply.code(status).send({ success: false, message: error });
  } finally {
    request.raw.off("aborted", onAbort);
    reply.raw.off("close", onClose);
  }
};

export const handleExitBrowserSession = async (
  server: FastifyInstance,
  request: FastifyRequest<{ Params: { sessionId?: string }; Body?: { sessionId?: unknown } }>,
  reply: FastifyReply,
) => {
  // POST /v1/sessions/release with { sessionId } releases only that session
  // (older clients use it as a fallback for the per-id route).
  const bodyId =
    request.body && typeof request.body.sessionId === "string" ? request.body.sessionId : undefined;
  const sessionId = request.params?.sessionId ?? bodyId;
  try {
    if (!sessionId) {
      // POST /v1/sessions/release: release everything that is live.
      const released = await server.sessionService.endAllSessions();
      const last = released[released.length - 1] ?? server.sessionService.activeSession;
      return reply.send({ success: true, ...last });
    }
    if (
      !server.sessionService.getSession(sessionId) &&
      !server.sessionService.isEnding(sessionId)
    ) {
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
  if (server.sessionService.isParked?.(request.params.sessionId))
    return reply
      .code(409)
      .send({ success: false, code: "session_parked", message: "Session is parked" });
  const session = server.sessionService.findSocketSession(request.params.sessionId);
  if (!session)
    return reply
      .code(404)
      .send({ success: false, code: "session_not_found", message: "Session not found" });
  const context = await session.cdpService.getBrowserState();
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
  request: FastifyRequest<{ Querystring: { include?: string } }>,
  reply: FastifyReply,
) => {
  // Live sessions first, newest first; then the idle browser if nothing is live;
  // then released ones, newest first.
  const live = server.sessionService.listSessions().reverse();
  const parked =
    request.query?.include === "parked"
      ? server.sessionService
          .listSessions(true)
          .filter((session) => session.status === "parked")
          .reverse()
      : [];
  const current = live.length > 0 ? live : [server.sessionService.activeSession];
  const past = [...server.sessionService.pastSessions].reverse();
  return reply.send({ sessions: [...current, ...parked, ...past].map(publicSession) });
};

export const handleGetSessionStream = async (
  server: FastifyInstance,
  request: SessionStreamRequest,
  reply: FastifyReply,
) => {
  const { showControls, theme, interactive, pageId, pageIndex } = request.query;
  const sessionId = (request.params as { sessionId?: string } | undefined)?.sessionId;
  if (sessionId && server.sessionService.isParked(sessionId))
    return reply
      .code(409)
      .send({ success: false, code: "session_parked", message: "Session is parked" });
  const session = sessionId
    ? server.sessionService.findSocketSession(sessionId)
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
    sessionId: session.id,
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
  if (server.sessionService.isParked?.(request.params.id))
    return reply
      .code(409)
      .send({ success: false, code: "session_parked", message: "Session is parked" });
  const session = server.sessionService.findSocketSession(request.params.id);
  if (!session)
    return reply
      .code(404)
      .send({ success: false, code: "session_not_found", message: "Session not found" });
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

    const browserVersion = await cdpService.getBrowserVersion();

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
