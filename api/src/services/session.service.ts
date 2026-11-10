import { FastifyBaseLogger } from "fastify";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
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
import { BrowserPool, PoolSlot, PoolClosedError } from "./browser-pool.service.js";
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

export const BROWSER_PROFILE_NAME = /^[a-zA-Z0-9._-]{1,64}$/;
/** steel-fingerprint.json in a saved browser's dir: its fingerprint, reused on every start. */
export const PROFILE_FINGERPRINT_FILE = "steel-fingerprint.json";
/**
 * Cookies of a saved browser, read over CDP when it is released. Chrome writes
 * its cookie database only every ~30 s and not on close, so a login made just
 * before Release would otherwise be lost; they are put back on the next start.
 */
export const PROFILE_COOKIES_FILE = "steel-cookies.json";

/** Where saved browsers (persistent Chrome profiles) live, one directory per name. */
export function browserProfilesDir(): string {
  return env.BROWSER_PROFILES_DIR || path.join(process.cwd(), "browser-profiles");
}

export class BrowserProfileInUseError extends Error {
  constructor(name: string, sessionId: string) {
    super(`Saved browser "${name}" is in use by session ${sessionId}. Release it first.`);
  }
}

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

export interface StartSessionOptions {
  sessionId?: string;
  proxyUrl?: string;
  /** Shown as the session's proxy instead of proxyUrl (which may carry credentials). */
  proxyLabel?: string;
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
  /** Saved browser: a named persistent Chrome profile under BROWSER_PROFILES_DIR. */
  browserProfile?: string;
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

  queueTimeout?: number;
  signal?: AbortSignal;
}

export type ProxyFactory = (
  proxyUrl: string,
  options?: OptimizeBandwidthOptions,
) => Promise<IProxyServer> | IProxyServer;

export function redactProxyUrl(value?: string): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.username) url.username = "redacted";
    if (url.password) url.password = "redacted";
    return url.toString();
  } catch {
    return "configured";
  }
}

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
  /** Saved browser name -> the session holding it (one Chrome per profile). */
  private profileLocks = new Map<string, string>();
  private starts = new Map<string, Promise<SessionDetails>>();
  private endings = new Map<string, Promise<SessionDetails>>();
  private closing = false;
  private closePromise?: Promise<void>;

  /** The session holding a saved browser, if any. */
  public profileHolder(name: string): string | undefined {
    return this.profileLocks.get(name);
  }

  /** The saved browser a session holds, if any. */
  private async saveProfileCookies(sessionId: string, cdp: CDPService): Promise<void> {
    const name = this.profileOf(sessionId);
    if (name === undefined) return;
    try {
      const cookies = await cdp.getCookies();
      await writeFile(
        path.join(browserProfilesDir(), name, PROFILE_COOKIES_FILE),
        JSON.stringify(cookies),
        { mode: 0o600 },
      );
    } catch (err) {
      this.logger.warn({ err }, `[SessionService] Could not save the cookies of ${name}`);
    }
  }

  public profileOf(sessionId: string): string | undefined {
    for (const [name, holder] of this.profileLocks) if (holder === sessionId) return name;
    return undefined;
  }

  /** Takes a saved browser for a session; throws BrowserProfileInUseError if another holds it. */
  public lockProfile(name: string, sessionId: string): void {
    const holder = this.profileLocks.get(name);
    if (holder !== undefined && holder !== sessionId)
      throw new BrowserProfileInUseError(name, holder);
    this.profileLocks.set(name, sessionId);
  }

  /** Lets go of whatever saved browser a session holds. */
  public unlockProfile(sessionId: string): void {
    const name = this.profileOf(sessionId);
    if (name !== undefined) this.profileLocks.delete(name);
  }

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
        if (slot.sessionId && slot.state === "live") {
          this.logger.warn(
            `[SessionService] Browser of session ${slot.sessionId} disconnected, releasing it`,
          );
          await this.endSession(slot.sessionId).catch((err) =>
            this.logger.error({ err }, "[SessionService] Failed to release disconnected session"),
          );
        } else if (slot.cdpService.primary && slot.state === "free" && !this.closing) {
          slot.state = "starting";
          try {
            await slot.cdpService.endSession();
            this.browserPool.idleReady(slot.index);
          } catch (error) {
            slot.state = "stopping";
            throw error;
          }
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

  public isEnding(sessionId: string): boolean {
    return this.endings.has(sessionId);
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
    browserProfile?: string,
  ): { dir: string; ephemeral: boolean } {
    if (browserProfile !== undefined) {
      return { dir: path.join(browserProfilesDir(), browserProfile), ephemeral: false };
    }
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

  public async startSession(options: StartSessionOptions): Promise<SessionDetails> {
    const sessionId = options.sessionId ?? uuidv4();
    if (this.sessions.has(sessionId) || this.starts.has(sessionId) || this.endings.has(sessionId)) {
      throw new Error(`Session ${sessionId} is already live or changing state`);
    }
    const task = this.startReservedSession({ ...options, sessionId });
    this.starts.set(sessionId, task);
    try {
      return await task;
    } finally {
      this.starts.delete(sessionId);
    }
  }

  public getPoolStatus() {
    return {
      maxSessions: this.browserPool.maxSessions,
      live: this.sessions.size,
      free: this.browserPool.allSlots.filter((slot) => slot.state === "free").length,
      queued: this.browserPool.queuedCount,
      queue: this.browserPool.queue,
      slots: this.browserPool.allSlots.map(({ index, cdpPort, state, sessionId }) => ({
        index,
        cdpPort,
        primary: index === 0,
        state,
        sessionId,
      })),
    };
  }

  /** Reject queued work before waiting for in-flight launches and releasing live sessions. */
  public close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.browserPool.close();
    this.closePromise = (async () => {
      await Promise.allSettled([...this.starts.values()]);
      await Promise.allSettled([
        ...this.endings.values(),
        ...this.listSessions().map((s) => this.endSession(s.id)),
      ]);
    })();
    return this.closePromise;
  }

  private async startReservedSession(
    options: StartSessionOptions & { sessionId: string },
  ): Promise<SessionDetails> {
    const {
      proxyUrl,
      userAgent,
      extensions,
      logSinkUrl,
      dimensions,
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
    let sessionContext = options.sessionContext;

    const sessionId = options.sessionId || uuidv4();
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} is already live`);
    }
    const browserProfile = options.browserProfile;
    if (browserProfile !== undefined) {
      if (!BROWSER_PROFILE_NAME.test(browserProfile)) {
        throw new Error("Saved browser names are 1-64 letters, digits, '.', '_' or '-'.");
      }
      if (isSelenium) throw new Error("Saved browsers do not work with Selenium sessions.");
      this.lockProfile(browserProfile, sessionId);
    }
    let fingerprint = options.fingerprint;

    // Selenium drives the primary browser's display, so it can only use slot 0.
    let slot: PoolSlot | null;
    try {
      slot = await this.browserPool.acquireWhenAvailable(sessionId, {
        primaryOnly: !!isSelenium,
        timeoutMs: Math.min(
          Math.max(0, options.queueTimeout ?? env.SESSION_QUEUE_TIMEOUT_MS ?? 0),
          env.SESSION_QUEUE_MAX_MS ?? 600_000,
        ),
        signal: options.signal,
      });
      if (!slot) throw new SessionPoolFullError(this.browserPool.maxSessions);
    } catch (error) {
      this.unlockProfile(sessionId);
      throw error;
    }
    const cdpService = slot.cdpService;
    let session: Session | undefined;

    try {
      options.signal?.throwIfAborted();
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
      session = {
        id: sessionId,
        createdAt: new Date().toISOString(),
        ...defaultSession,
        ...sessionStats,
        status: "live",
        proxy: options.proxyLabel ?? redactProxyUrl(proxyUrl),
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
        ...(browserProfile !== undefined ? { browserProfile } : {}),
      };
      const profile = this.userDataDirFor(
        slot,
        sessionId,
        options.persist,
        options.userDataDir,
        browserProfile,
      );
      const userDataDir = profile.dir;
      if (profile.ephemeral) this.ephemeralProfiles.set(sessionId, userDataDir);
      await mkdir(userDataDir, { recursive: true });
      if (browserProfile !== undefined) {
        // A Chrome that died without closing leaves its lock behind; we hold
        // the only claim on this profile, so it is stale.
        for (const lock of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
          await rm(path.join(userDataDir, lock), { force: true }).catch(() => undefined);
        }
        if (!sessionContext?.cookies?.length) {
          const cookies = await readFile(path.join(userDataDir, PROFILE_COOKIES_FILE), "utf8")
            .then((raw) => JSON.parse(raw) as CookieData[])
            .catch(() => undefined);
          if (cookies?.length) sessionContext = { ...(sessionContext ?? {}), cookies };
        }
        // Same device every time: reuse the fingerprint this browser first got.
        if (!fingerprint && !skipFingerprintInjection) {
          fingerprint = await readFile(path.join(userDataDir, PROFILE_FINGERPRINT_FILE), "utf8")
            .then((raw) => JSON.parse(raw) as BrowserFingerprintWithHeaders)
            .catch(() => undefined);
        }
      }

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
        if (browserProfile !== undefined && !fingerprint && !skipFingerprintInjection) {
          const generated = cdpService.getFingerprintData();
          if (generated) {
            await writeFile(
              path.join(userDataDir, PROFILE_FINGERPRINT_FILE),
              JSON.stringify(generated),
              { mode: 0o600 },
            ).catch((err) =>
              this.logger.warn(
                { err },
                `[SessionService] Could not save the fingerprint of ${browserProfile}`,
              ),
            );
          }
        }

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

      options.signal?.throwIfAborted();
      if (this.closing) throw new PoolClosedError();
      if (!cdpService.isRunning() && !isSelenium)
        throw new Error("Browser disconnected during launch");
      this.sessions.set(sessionId, session);
      this.browserPool.markLive(sessionId);
      return session;
    } catch (error) {
      this.browserPool.markStopping(sessionId);
      let reusable = false;
      try {
        if (isSelenium) await this.seleniumService.close();
        await slot.cdpService.shutdown(ShutdownReason.LAUNCH_FAILURE);
        if (slot.cdpService.primary && !this.closing) await slot.cdpService.launch();
        reusable = true;
      } catch (cleanupError) {
        this.logger.error(
          { err: cleanupError, sessionId },
          "Browser cleanup failed; keeping slot unavailable",
        );
      }
      try {
        await session?.proxyServer?.close(true);
      } catch (cleanupError) {
        this.logger.error({ err: cleanupError }, "Failed to close session proxy");
      } finally {
        session?.complete();
        // Never delete a profile or lend a slot while Chrome may still own it.
        if (reusable) {
          await this.removeProfile(sessionId);
          this.unlockProfile(sessionId);
          this.browserPool.release(sessionId);
        }
      }
      throw error;
    }
  }

  /** Releases one session (default: the most recent live one). */
  public async endSession(sessionId?: string): Promise<SessionDetails> {
    const id = sessionId ?? this.activeSession.id;
    const existing = this.endings.get(id);
    if (existing) return existing;
    const session = this.sessions.get(id);
    if (!session || session.status !== "live" || !this.sessions.has(session.id)) {
      throw new Error(sessionId ? `Session ${sessionId} not found` : "No live session");
    }

    const task = this.finishSession(session);
    this.endings.set(id, task);
    try {
      return await task;
    } finally {
      this.endings.delete(id);
    }
  }

  private async finishSession(session: Session): Promise<SessionDetails> {
    this.sessions.delete(session.id);
    this.browserPool.markStopping(session.id);
    session.complete();
    session.status = "released";
    session.duration = new Date().getTime() - new Date(session.createdAt).getTime();

    let reusable = false;
    try {
      if (session.isSelenium) {
        await this.seleniumService.close();
        await this.primaryCdp.launch();
      } else {
        await this.saveProfileCookies(session.id, session.cdpService);
        await session.cdpService.endSession();
      }
      reusable = true;
    } catch (error) {
      // An end hook or idle relaunch may fail after Chrome exits. Make a second,
      // explicit cleanup attempt; never hand a still-owned slot to another caller.
      try {
        if (session.isSelenium) await this.seleniumService.close();
        await session.cdpService.shutdown(ShutdownReason.SESSION_END);
        if (session.cdpService.primary && !this.closing) await session.cdpService.launch();
        reusable = true;
      } catch (cleanupError) {
        this.logger.error(
          { err: cleanupError, sessionId: session.id },
          "Browser cleanup failed; keeping slot unavailable",
        );
      }
      throw error;
    } finally {
      const proxyServer = session.proxyServer;
      try {
        await proxyServer?.close(true);
      } catch (error) {
        this.logger.error({ err: error }, "Failed to close session proxy");
      }
      session.proxyServer = undefined;
      // A connection is credited on `connectionClosed`, and long-lived tunnels stay
      // open until the browser goes away, so take the counters once the proxy has
      // closed to get the settled totals.
      if (proxyServer) {
        session.proxyTxBytes = proxyServer.txBytes;
        session.proxyRxBytes = proxyServer.rxBytes;
      }

      if (reusable) {
        await this.removeProfile(session.id);
        this.unlockProfile(session.id);
        this.browserPool.release(session.id);
      }
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
