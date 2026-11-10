import { FastifyBaseLogger } from "fastify";
import { mkdir, rm } from "fs/promises";
import os from "os";
import path, { dirname } from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import { env } from "../env.js";
import { BrowserFingerprintWithHeaders } from "fingerprint-generator";
import { CredentialsOptions, SessionDetails } from "../modules/sessions/sessions.schema.js";
import {
  BrowserLaunchExtra,
  BrowserLauncherOptions,
  OptimizeBandwidthOptions,
} from "../types/index.js";
import { IProxyServer, ProxyServer } from "../utils/proxy.js";
import { getBaseUrl, getSessionUrl, getUrl } from "../utils/url.js";
import { BrowserPool, PoolSlot } from "./browser-pool.service.js";
import { CDPService } from "./cdp/cdp.service.js";
import { ShutdownReason } from "./cdp/plugins/core/base-plugin.js";
import { CookieData } from "./context/types.js";
import { FileService } from "./file.service.js";
import { SeleniumService } from "./selenium.service.js";
import { TimezoneFetcher } from "./timezone-fetcher.service.js";
import { deepMerge } from "../utils/context.js";

export type Session = SessionDetails & {
  completion: Promise<void>;
  complete: (value: void) => void;
  proxyServer: IProxyServer | undefined;
  /** The browser serving this session (the primary browser for the idle placeholder). */
  cdpService: CDPService;
  /** Pool slot index, or -1 for the idle placeholder. */
  slot: number;
};

export class SessionPoolFullError extends Error {
  constructor(maxSessions: number) {
    super(
      `All ${maxSessions} browser slot(s) are in use. Release a session (POST /v1/sessions/<id>/release) and retry.`,
    );
    this.name = "SessionPoolFullError";
  }
}

const sessionStats = {
  duration: 0,
  eventCount: 0,
  timeout: 0,
  creditsUsed: 0,
  proxyTxBytes: 0,
  proxyRxBytes: 0,
};

const defaultSession = {
  status: "idle" as SessionDetails["status"],
  websocketUrl: getBaseUrl("ws"),
  debugUrl: getUrl("v1/sessions/debug"),
  debuggerUrl: getUrl("v1/devtools/inspector.html"),
  sessionViewerUrl: getBaseUrl(),
  dimensions: { width: 1920, height: 1080 },
  userAgent: "",
  isSelenium: false,
  proxy: "",
  solveCaptcha: false,
};

export type ProxyFactory = (
  proxyUrl: string,
  options?: OptimizeBandwidthOptions,
) => Promise<IProxyServer> | IProxyServer;

export class SessionService {
  private logger: FastifyBaseLogger;
  private browserPool: BrowserPool;
  private seleniumService: SeleniumService;
  private fileService: FileService;
  private timezoneFetcher: TimezoneFetcher;
  public proxyFactory: ProxyFactory = (proxyUrl) => new ProxyServer(proxyUrl);

  public pastSessions: Session[] = [];
  /** Live sessions by id, in start order. */
  private sessions = new Map<string, Session>();
  /** Placeholder describing the idle primary browser when no session is live. */
  private idleSession: Session;
  /** Throwaway profile directories by session id, deleted on release. */
  private ephemeralProfiles = new Map<string, string>();

  constructor(config: {
    browserPool: BrowserPool;
    seleniumService: SeleniumService;
    fileService: FileService;
    logger: FastifyBaseLogger;
  }) {
    this.browserPool = config.browserPool;
    this.seleniumService = config.seleniumService;
    this.fileService = config.fileService;
    this.logger = config.logger;
    this.timezoneFetcher = new TimezoneFetcher(config.logger);
    this.idleSession = this.makeIdleSession();

    // When a session's browser goes away on its own (crash, killed, closed by
    // the client), release the session too instead of leaving it "live".
    for (const slot of this.browserPool.allSlots) {
      slot.cdpService.setDisconnectHandler(async () => {
        if (slot.sessionId) {
          this.logger.warn(
            `[SessionService] Browser of session ${slot.sessionId} disconnected, releasing it`,
          );
          await this.endSession(slot.sessionId).catch((err) =>
            this.logger.error({ err }, "[SessionService] Failed to release disconnected session"),
          );
        } else if (slot.cdpService.primary) {
          await slot.cdpService.endSession();
        }
      });
    }
  }

  private get primaryCdp(): CDPService {
    return this.browserPool.primary.cdpService;
  }

  private makeIdleSession(): Session {
    return {
      id: uuidv4(),
      createdAt: new Date().toISOString(),
      ...defaultSession,
      ...sessionStats,
      userAgent: this.primaryCdp.getUserAgent() ?? "",
      dimensions: this.primaryCdp.getDimensions(),
      completion: Promise.resolve(),
      complete: () => {},
      proxyServer: undefined,
      cdpService: this.primaryCdp,
      slot: -1,
    };
  }

  /**
   * The most recently started live session, or the idle placeholder. Kept for
   * the single-session code paths (unscoped endpoints, commands API).
   */
  public get activeSession(): Session {
    const live = Array.from(this.sessions.values());
    return live[live.length - 1] ?? this.idleSession;
  }

  public getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /** A live session, or the idle one (the primary browser between sessions). */
  public findSocketSession(sessionId: string): Session | undefined {
    return (
      this.sessions.get(sessionId) ??
      (this.idleSession.id === sessionId ? this.idleSession : undefined)
    );
  }

  public listSessions(): Session[] {
    return Array.from(this.sessions.values());
  }

  public get maxSessions(): number {
    return this.browserPool.maxSessions;
  }

  /**
   * Each Chrome needs its own profile directory: two browsers on one profile
   * fight over its SingletonLock. A non-persistent session also gets a fresh
   * profile, removed on release, so cookies, storage and tabs never carry over
   * to the next session on the same slot.
   */
  private userDataDirFor(
    slot: PoolSlot,
    sessionId: string,
    persist: boolean | undefined,
    custom?: string,
  ): { dir: string; ephemeral: boolean } {
    if (custom || persist === true) {
      const suffix = slot.index === 0 ? "" : `-${slot.index}`;
      return {
        dir: path.join(
          dirname(fileURLToPath(import.meta.url)),
          "..",
          "..",
          `user-data-dir${suffix}`,
        ),
        ephemeral: false,
      };
    }
    const base = env.CHROME_USER_DATA_DIR || path.join(os.tmpdir(), "steel-chrome");
    return { dir: `${base}-session-${sessionId}`, ephemeral: true };
  }

  public async startSession(options: {
    sessionId?: string;
    proxyUrl?: string;
    userAgent?: string;
    sessionContext?: {
      cookies?: CookieData[];
      localStorage?: Record<string, Record<string, any>>;
    };
    isSelenium?: boolean;
    fingerprint?: BrowserFingerprintWithHeaders;
    logSinkUrl?: string;
    userDataDir?: string;
    persist?: boolean;
    blockAds?: boolean;
    optimizeBandwidth?: boolean | OptimizeBandwidthOptions;
    extensions?: string[];
    timezone?: string;
    dimensions?: { width: number; height: number };
    extra?: BrowserLaunchExtra;
    credentials: CredentialsOptions;
    skipFingerprintInjection?: boolean;
    userPreferences?: Record<string, any>;
    deviceConfig?: { device: "desktop" | "mobile" };
    fullscreen?: boolean;
    headless?: boolean;
    dangerouslyLogRequestDetails?: boolean;
    captureWorkerNetwork?: boolean;
    caCertificates?: string[];
  }): Promise<SessionDetails> {
    const {
      proxyUrl,
      userAgent,
      sessionContext,
      extensions,
      logSinkUrl,
      dimensions,
      fingerprint,
      isSelenium,
      blockAds,
      optimizeBandwidth,
      extra,
      credentials,
      skipFingerprintInjection,
      userPreferences,
      deviceConfig,
      fullscreen,
      headless,
      dangerouslyLogRequestDetails,
      captureWorkerNetwork,
      caCertificates,
    } = options;

    const sessionId = options.sessionId || uuidv4();
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} is already live`);
    }

    // Selenium drives the primary browser's display, so it can only use slot 0.
    const slot = this.browserPool.acquire(sessionId, { primaryOnly: !!isSelenium });
    if (!slot) {
      throw new SessionPoolFullError(this.browserPool.maxSessions);
    }
    const cdpService = slot.cdpService;

    try {
      // start fetching timezone as early as possible
      let timezonePromise: Promise<string>;
      if (options.timezone) {
        timezonePromise = Promise.resolve(options.timezone);
      } else {
        timezonePromise = this.timezoneFetcher.getTimezone(
          proxyUrl,
          env.DEFAULT_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone,
        );
      }

      // If dimensions not provided, get from CDP service
      const MIN_MOBILE_WIDTH = 508;
      const MIN_MOBILE_HEIGHT = 1074;
      const isMobileDevice = deviceConfig?.device === "mobile";
      const resolvedDimensions = dimensions || cdpService.getDimensions();
      const finalDimensions =
        isMobileDevice && resolvedDimensions
          ? {
              width: Math.max(resolvedDimensions.width, MIN_MOBILE_WIDTH),
              height: Math.max(resolvedDimensions.height, MIN_MOBILE_HEIGHT),
            }
          : resolvedDimensions;

      const { promise, resolve } = Promise.withResolvers<void>();
      const session: Session = {
        id: sessionId,
        createdAt: new Date().toISOString(),
        ...defaultSession,
        ...sessionStats,
        status: "live",
        proxy: proxyUrl ?? "",
        solveCaptcha: false,
        dimensions: finalDimensions,
        isSelenium: !!isSelenium,
        deviceConfig,
        userAgent: "",
        completion: promise,
        complete: resolve,
        proxyServer: undefined,
        cdpService,
        slot: slot.index,
      };
      this.sessions.set(sessionId, session);

      const profile = this.userDataDirFor(slot, sessionId, options.persist, options.userDataDir);
      const userDataDir = profile.dir;
      if (profile.ephemeral) this.ephemeralProfiles.set(sessionId, userDataDir);
      await mkdir(userDataDir, { recursive: true });

      const defaultUserPreferences = {
        plugins: {
          always_open_pdf_externally: true,
          plugins_disabled: ["Chrome PDF Viewer"],
        },
      };

      const mergedUserPreferences = userPreferences
        ? deepMerge(defaultUserPreferences, userPreferences)
        : defaultUserPreferences;

      // Normalize optimizeBandwidth: true => enable all flags (except lists)
      const normalizeOptimizeBandwidth = (
        value: boolean | OptimizeBandwidthOptions | undefined,
      ): OptimizeBandwidthOptions | undefined => {
        if (value === true) {
          return { blockImages: true, blockMedia: true, blockStylesheets: true };
        }
        if (value && typeof value === "object") {
          return { ...value };
        }
        return undefined;
      };

      const normalizedOptimize = normalizeOptimizeBandwidth(optimizeBandwidth);

      if (proxyUrl) {
        session.proxyServer = await this.proxyFactory(proxyUrl, normalizedOptimize);
        await session.proxyServer.listen();
      }

      const browserLauncherOptions: BrowserLauncherOptions = {
        options: {
          headless: headless ?? env.CHROME_HEADLESS,
          proxyUrl: session.proxyServer?.url,
        },
        sessionContext,
        userAgent,
        blockAds,
        fingerprint,
        optimizeBandwidth: normalizedOptimize,
        extensions: extensions || [],
        logSinkUrl,
        timezone: timezonePromise,
        dimensions: finalDimensions,
        userDataDir,
        userPreferences: mergedUserPreferences,
        extra,
        credentials,
        skipFingerprintInjection,
        deviceConfig,
        fullscreen,
        dangerouslyLogRequestDetails,
        captureWorkerNetwork,
        caCertificates,
      };

      if (isSelenium) {
        await cdpService.shutdown(ShutdownReason.MODE_SWITCH);
        await this.seleniumService.launch(browserLauncherOptions);

        Object.assign(session, {
          websocketUrl: "",
          debugUrl: "",
          sessionViewerUrl: "",
          userAgent:
            userAgent ||
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
          dimensions: cdpService.getDimensions(),
          deviceConfig,
        });
      } else {
        await cdpService.startNewSession(browserLauncherOptions);

        Object.assign(session, {
          // The primary browser keeps the stock URLs so single-session clients
          // see no change; other slots get session-scoped ones.
          websocketUrl: slot.index === 0 ? getBaseUrl("ws") : getSessionUrl(sessionId, "cdp", "ws"),
          debugUrl: getSessionUrl(sessionId, "debug"),
          debuggerUrl: getUrl("v1/devtools/inspector.html"),
          sessionViewerUrl: getBaseUrl(),
          userAgent:
            cdpService.getUserAgent() ||
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
          dimensions: cdpService.getDimensions(),
          deviceConfig,
        });
      }

      return session;
    } catch (error) {
      void this.removeProfile(sessionId);
      const session = this.sessions.get(sessionId);
      this.sessions.delete(sessionId);
      this.browserPool.release(sessionId);
      await session?.proxyServer?.close(true).catch(() => undefined);
      if (!slot.cdpService.primary) {
        await slot.cdpService.shutdown(ShutdownReason.LAUNCH_FAILURE).catch(() => undefined);
      }
      throw error;
    }
  }

  /** Releases one session (default: the most recent live one). */
  public async endSession(sessionId?: string): Promise<SessionDetails> {
    const session = sessionId ? this.sessions.get(sessionId) : this.activeSession;
    if (!session || session.status !== "live" || !this.sessions.has(session.id)) {
      throw new Error(sessionId ? `Session ${sessionId} not found` : "No live session");
    }

    // Take it out of the live set first, so the browser's disconnect handler
    // does not try to release it a second time while it is being torn down.
    this.sessions.delete(session.id);
    this.browserPool.release(session.id);

    session.complete();
    session.status = "released";
    session.duration = new Date().getTime() - new Date(session.createdAt).getTime();

    try {
      if (session.isSelenium) {
        this.seleniumService.close();
        await this.primaryCdp.launch();
      } else {
        await session.cdpService.endSession();
      }
    } finally {
      const proxyServer = session.proxyServer;
      await proxyServer?.close(true);
      session.proxyServer = undefined;
      // A connection is credited on `connectionClosed`, and long-lived tunnels stay
      // open until the browser goes away, so take the counters once the proxy has
      // closed to get the settled totals.
      if (proxyServer) {
        session.proxyTxBytes = proxyServer.txBytes;
        session.proxyRxBytes = proxyServer.rxBytes;
      }

      await this.removeProfile(session.id);
      if (this.sessions.size === 0) {
        this.idleSession = this.makeIdleSession();
      }
      this.pastSessions.push(session);
      if (this.pastSessions.length > 100) this.pastSessions.shift();
    }

    return session;
  }

  private async removeProfile(sessionId: string) {
    const dir = this.ephemeralProfiles.get(sessionId);
    if (!dir) return;
    this.ephemeralProfiles.delete(sessionId);
    await rm(dir, { recursive: true, force: true }).catch((err) =>
      this.logger.warn({ err }, `[SessionService] Could not remove profile ${dir}`),
    );
  }

  /** Releases every live session. */
  public async endAllSessions(): Promise<SessionDetails[]> {
    const ids = Array.from(this.sessions.keys());
    const released: SessionDetails[] = [];
    for (const id of ids) {
      released.push(await this.endSession(id));
    }
    return released;
  }

  public setProxyFactory(factory: ProxyFactory) {
    this.proxyFactory = factory;
  }
}
