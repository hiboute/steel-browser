import { FastifyBaseLogger } from "fastify";
import { mkdir, readFile, rm, writeFile, rename, cp, stat } from "fs/promises";
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
import { SessionHookRegistry, type EndReason, type ParkReason } from "./session-hooks.js";
import { readProfileCookies, writeProfileCookies } from "./profile-cookies.js";
import { PlatformStore } from "./platform/store.js";
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

export const BROWSER_PROFILE_NAME = /^(?!\.\.?$)[a-zA-Z0-9._-]{1,64}$/;
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
  constructor(
    maxSessions: number,
    public code: "pool_full" | "low_memory" = "pool_full",
  ) {
    super(
      code === "low_memory"
        ? "Available memory is below the configured reserve. Release a session or retry when memory pressure falls."
        : `All ${maxSessions} browser slot(s) are in use. Release a session (POST /v1/sessions/<id>/release) and retry.`,
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
  name?: string;
  labels?: Record<string, string>;
  client?: string;
  cookieSets?: string[];
  cookieSetWriteBack?: boolean;
  egress?: string;
  record?: boolean;
  timeout?: number;
  idleTimeout?: number;
  onExpire?: "park" | "release";
  keepAlive?: boolean;
  /** Internal restoration marker, never accepted from HTTP. */
  _resuming?: boolean;
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

interface ParkedSnapshot {
  details: SessionDetails;
  options: StartSessionOptions;
  profile: string;
  ephemeral: boolean;
  cookies: CookieData[];
  tabs: {
    url: string;
    title: string;
    active: boolean;
    scrollX: number;
    scrollY: number;
    storage: Record<string, string>;
  }[];
  profileVersion?: number;
}

export class SessionStateError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 409,
  ) {
    super(message);
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
  private pathOwners = new Map<string, string>();
  private starts = new Map<string, Promise<SessionDetails>>();
  private endings = new Map<string, Promise<SessionDetails>>();
  private transitioning = new Map<string, Session>();
  private closing = false;
  private closePromise?: Promise<void>;
  public readonly hooks: SessionHookRegistry;
  private readonly store = new PlatformStore(
    env.STEEL_DATA_DIR || path.join(process.cwd(), "data"),
    env.STEEL_DATA_KEY || env.COOKIE_LIBRARY_KEY,
  );
  private parked = new Map<string, Session>();
  private snapshots = new Map<string, ParkedSnapshot>();
  private launchOptions = new Map<string, StartSessionOptions>();
  private holds = new Map<string, number>();
  private reaper?: NodeJS.Timeout;
  private reaping?: Promise<void>;
  private idleExemption: (id: string) => boolean = () => false;
  private parkGuard: (id: string) => boolean = () => false;
  private poolDetails: () => Record<string, unknown> = () => ({});
  private resolveEgress?: (
    name?: string,
  ) => Promise<{ name: string; proxyUrl?: string; proxyLabel?: string }>;
  private thumbnails = new Map<string, { at: number; data: Buffer }>();

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
      await writeProfileCookies(path.join(browserProfilesDir(), name), cookies);
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
    this.hooks = new SessionHookRegistry(this.logger);
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
          await this.endSession(slot.sessionId, "disconnected").catch((err) =>
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
    return (
      this.sessions.get(sessionId) ??
      this.parked.get(sessionId) ??
      this.transitioning.get(sessionId)
    );
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

  public listSessions(includeParked = false): Session[] {
    return [...this.sessions.values(), ...(includeParked ? this.parked.values() : [])];
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
    if (custom) return { dir: custom, ephemeral: !browserProfile && persist !== true };
    if (persist === true) {
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
    if (this.closing) throw new PoolClosedError();
    const sessionId = options.sessionId ?? uuidv4();
    if (this.parked.has(sessionId) && !options._resuming)
      throw new SessionStateError("session_parked", "Session is parked; resume it instead");
    if (this.sessions.has(sessionId) || this.starts.has(sessionId) || this.endings.has(sessionId)) {
      throw new Error(`Session ${sessionId} is already live or changing state`);
    }
    const task = this.startReservedSession({ ...options, sessionId });
    this.starts.set(sessionId, task);
    try {
      return await task;
    } finally {
      this.starts.delete(sessionId);
      if (!this.sessions.has(sessionId)) this.launchOptions.delete(sessionId);
    }
  }

  public getPoolStatus() {
    const extra = this.poolDetails();
    const slotStats = (extra.slotStats ?? {}) as Record<number, Record<string, unknown>>;
    return {
      ...extra,
      parked: this.parked.size,
      maxSessions: this.browserPool.maxSessions,
      live: this.sessions.size,
      free: this.browserPool.allSlots.filter((slot) => slot.state === "free").length,
      queued: this.browserPool.queuedCount,
      queue: this.browserPool.queue.map((entry) => ({
        ...entry,
        client: this.launchOptions.get(entry.sessionId)?.client ?? "anonymous",
        kind: this.snapshots.has(entry.sessionId) ? "resume" : "create",
      })),
      slots: this.browserPool.allSlots.map(({ index, cdpPort, state, sessionId }) => ({
        ...slotStats[index],
        index,
        cdpPort,
        primary: index === 0,
        state,
        sessionId,
        sessionName: sessionId ? this.sessions.get(sessionId)?.name : undefined,
      })),
    };
  }

  /** Reject queued work before waiting for in-flight launches and releasing live sessions. */
  public close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    clearInterval(this.reaper);
    this.browserPool.close();
    this.closePromise = (async () => {
      await Promise.allSettled([...this.starts.values()]);
      await Promise.allSettled([
        ...this.endings.values(),
        ...this.listSessions().map(async (s) => {
          if (!s.isSelenium) {
            try {
              await this.parkSession(s.id, "shutdown");
              return;
            } catch (err) {
              this.logger.warn({ err }, "Could not park session on shutdown");
            }
          }
          if (this.sessions.has(s.id)) await this.endSession(s.id, "shutdown");
        }),
      ]);
    })();
    return this.closePromise;
  }

  private async startReservedSession(
    options: StartSessionOptions & { sessionId: string },
  ): Promise<SessionDetails> {
    let restoreSessionStorage = true;
    if (options._resuming) {
      const snapshot = this.snapshots.get(options.sessionId);
      if (!snapshot)
        throw new SessionStateError("session_not_found", "Parked session not found", 404);
      const changed =
        snapshot.options.browserProfile &&
        (await this.profileVersion(snapshot.options.browserProfile)) !== snapshot.profileVersion;
      options.sessionContext = changed ? undefined : { cookies: snapshot.cookies };
      restoreSessionStorage = !changed;
    } else await this.hooks.run("onStarting", options);
    if (this.resolveEgress && !options.proxyUrl) {
      const resolved = await this.resolveEgress(options.egress);
      options.egress = resolved.name;
      options.proxyUrl = resolved.proxyUrl;
      options.proxyLabel = resolved.proxyLabel;
    }
    this.launchOptions.set(options.sessionId, { ...options, signal: undefined });
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
      const waiting = this.browserPool.acquireWhenAvailable(sessionId, {
        primaryOnly: !!isSelenium,
        background: !!(options.labels?.background || options.labels?.warm),
        timeoutMs: Math.min(
          Math.max(0, options.queueTimeout ?? env.SESSION_QUEUE_TIMEOUT_MS ?? 0),
          env.SESSION_QUEUE_MAX_MS ?? 600_000,
        ),
        signal: options.signal,
      });
      if (
        (options.queueTimeout ?? env.SESSION_QUEUE_TIMEOUT_MS ?? 0) > 0 &&
        !options.labels?.background &&
        !options.labels?.warm
      )
        void this.preempt().catch((err) => this.logger.warn({ err }, "Session preemption failed"));
      slot = await waiting;
      if (!slot)
        throw new SessionPoolFullError(
          this.browserPool.maxSessions,
          this.browserPool.hasMemoryCapacity?.() === false ? "low_memory" : "pool_full",
        );
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
        name: options.name,
        labels: options.labels ?? {},
        client: options.client ?? "anonymous",
        timeout: options.timeout ?? env.SESSION_TIMEOUT_MS ?? 0,
        idleTimeout: options.idleTimeout ?? env.SESSION_IDLE_TIMEOUT_MS ?? 0,
        onExpire: options.onExpire ?? env.SESSION_EXPIRE_ACTION ?? "park",
        keepAlive: options.keepAlive ?? false,
        lastActivityAt: new Date().toISOString(),
        expiresAt: null,
        resumeCount: 0,
        cookieSets: options.cookieSets ?? [],
        cookieSetWriteBack: options.cookieSetWriteBack ?? true,
        egress: options.egress,
        recording: options.record ?? false,
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
      const owner = this.pathOwners.get(path.resolve(userDataDir));
      if (owner && owner !== sessionId)
        throw new SessionStateError(
          "profile_in_use",
          "Browser profile is owned by another live or parked session",
        );
      this.pathOwners.set(path.resolve(userDataDir), sessionId);
      this.launchOptions.set(sessionId, { ...options, userDataDir, signal: undefined });
      if (profile.ephemeral) this.ephemeralProfiles.set(sessionId, userDataDir);
      await mkdir(userDataDir, { recursive: true });
      if (browserProfile !== undefined) {
        // A Chrome that died without closing leaves its lock behind; we hold
        // the only claim on this profile, so it is stale.
        for (const lock of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
          await rm(path.join(userDataDir, lock), { force: true }).catch(() => undefined);
        }
        if (!sessionContext?.cookies?.length) {
          const cookies = await readProfileCookies(userDataDir);
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
        downloadPath: this.fileService.forSession?.(sessionId).getBaseFilesPath(),
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
      const effective = this.launchOptions.get(sessionId)!;
      effective.timezone = await timezonePromise;
      effective.fingerprint = cdpService.getFingerprintData?.() ?? fingerprint;
      effective.userAgent = session.userAgent;
      effective.dimensions = session.dimensions;
      if (options._resuming) {
        const snapshot = this.snapshots.get(sessionId)!;
        session.createdAt = snapshot.details.createdAt;
        session.resumeCount = (snapshot.details.resumeCount ?? 0) + 1;
        await this.restoreTabs(session, snapshot, restoreSessionStorage);
      }
      options.signal?.throwIfAborted();
      if (this.closing) throw new PoolClosedError();
      if (!isSelenium && !cdpService.isRunning())
        throw new Error("Browser disconnected during restoration");
      this.sessions.set(sessionId, session);
      this.parked.delete(sessionId);
      this.updateExpiry(session);
      this.browserPool.markLive(sessionId);
      await this.hooks.run(options._resuming ? "onResumed" : "onStarted", session);
      options.signal?.throwIfAborted();
      if (this.closing) throw new PoolClosedError();
      return session;
    } catch (error) {
      const published = session && this.sessions.get(sessionId) === session;
      if (published) {
        this.sessions.delete(sessionId);
        await this.hooks.run("onEnding", session!, {
          reason: this.closing ? "shutdown" : "disconnected",
          park: false,
        });
      }
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
          if (!options._resuming) {
            await this.removeProfile(sessionId);
            for (const [dir, owner] of this.pathOwners)
              if (owner === sessionId) this.pathOwners.delete(dir);
          }
          this.unlockProfile(sessionId);
          this.browserPool.release(sessionId);
        }
      }
      if (published && session) {
        if (options._resuming) {
          const snapshot = this.snapshots.get(sessionId)!;
          Object.assign(session, snapshot.details, {
            status: "parked",
            slot: -1,
            proxyServer: undefined,
            expiresAt: null,
          });
          this.parked.set(sessionId, session);
        } else {
          session.status = "released";
          session.releaseReason = this.closing ? "shutdown" : "disconnected";
          await this.hooks.run("onEnded", session);
        }
      }
      throw error;
    }
  }

  /** Releases one session (default: the most recent live one). */
  public async endSession(sessionId?: string, reason: EndReason = "api"): Promise<SessionDetails> {
    const id = sessionId ?? this.activeSession.id;
    const starting = this.starts.get(id);
    if (starting) {
      await starting.catch(() => undefined);
      return this.endSession(id, reason);
    }
    const existing = this.endings.get(id);
    if (existing) {
      const result = await existing;
      return result.status === "parked" ? this.endSession(id, reason) : result;
    }
    if (this.parked.has(id)) {
      const task = this.discardParked(id, reason);
      this.endings.set(id, task);
      try {
        return await task;
      } finally {
        this.endings.delete(id);
      }
    }
    const session = this.sessions.get(id);
    if (!session || session.status !== "live" || !this.sessions.has(session.id)) {
      throw new Error(sessionId ? `Session ${sessionId} not found` : "No live session");
    }

    const task = this.finishSession(session, reason);
    this.endings.set(id, task);
    try {
      return await task;
    } finally {
      this.endings.delete(id);
      this.transitioning.delete(id);
    }
  }

  private async finishSession(session: Session, reason: EndReason): Promise<SessionDetails> {
    this.transitioning.set(session.id, session);
    this.sessions.delete(session.id);
    this.browserPool.markStopping(session.id);
    session.complete();
    session.releaseReason = reason;
    session.status = "released";
    session.expiresAt = null;
    session.duration = new Date().getTime() - new Date(session.createdAt).getTime();

    let reusable = false;
    try {
      await this.hooks.run("onEnding", session, { reason, park: false });
      if (session.isSelenium) {
        await this.seleniumService.close();
        if (!this.closing) await this.primaryCdp.launch();
      } else {
        await this.saveProfileCookies(session.id, session.cdpService);
        await session.cdpService.endSession(ShutdownReason.SESSION_END, !this.closing);
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
        for (const [dir, owner] of this.pathOwners)
          if (owner === session.id) this.pathOwners.delete(dir);
        this.unlockProfile(session.id);
        this.browserPool.release(session.id);
      }
      if (this.sessions.size === 0) {
        this.idleSession = this.makeIdleSession();
      }
      this.holds.delete(session.id);
      this.launchOptions.delete(session.id);
      this.thumbnails.delete(session.id);
      if (reusable) await this.store.remove(`parked/${session.id}`);
      this.snapshots.delete(session.id);
      await this.hooks.run("onEnded", session);
      this.pastSessions.push(session);
      if (this.pastSessions.length > 100) this.pastSessions.shift();
    }

    return session;
  }

  public setIdleExemption(check: (id: string) => boolean) {
    this.idleExemption = check;
  }
  public setParkGuard(check: (id: string) => boolean) {
    this.parkGuard = check;
  }
  public setEgressResolver(resolve: NonNullable<SessionService["resolveEgress"]>) {
    this.resolveEgress = resolve;
  }
  public setPoolDetails(get: () => Record<string, unknown>) {
    this.poolDetails = get;
  }
  public get isClosing() {
    return this.closing;
  }
  public getLaunchOptions(id: string): StartSessionOptions | undefined {
    return this.launchOptions.get(id) ?? this.snapshots.get(id)?.options;
  }
  public isParked(id: string) {
    return this.parked.has(id);
  }

  /** Restore parked metadata before accepting requests, then start one non-overlapping reaper. */
  public async initialize(): Promise<void> {
    for (const id of await this.store.list("parked")) {
      if (!/^[a-zA-Z0-9_-]+$/.test(id)) continue;
      try {
        const snapshot = await this.store.read<ParkedSnapshot>(`parked/${id}/meta.json`);
        if (!snapshot || snapshot.details.id !== id || !snapshot.profile) continue;
        try {
          await stat(snapshot.profile);
        } catch {
          const relocated = this.store.path(`parked/${id}/profile`);
          await stat(relocated);
          snapshot.profile = relocated;
          snapshot.options.userDataDir = relocated;
          await this.store.write(`parked/${id}/meta.json`, snapshot);
        }
        if (!snapshot.options.browserProfile)
          this.pathOwners.set(path.resolve(snapshot.profile), id);
        this.snapshots.set(id, snapshot);
        this.parked.set(id, {
          ...snapshot.details,
          status: "parked",
          slot: -1,
          expiresAt: null,
          cdpService: this.primaryCdp,
          proxyServer: undefined,
          completion: Promise.resolve(),
          complete: () => {},
        });
      } catch (err) {
        this.logger.warn({ err, sessionId: id }, "Could not restore parked session");
      }
    }
    await this.pruneParked();
    this.reaper = setInterval(() => {
      void this.reapExpiredSessions().catch((err) =>
        this.logger.error({ err }, "Session reaper failed"),
      );
    }, env.SESSION_REAPER_INTERVAL_MS ?? 10_000);
    this.reaper.unref();
  }

  private exemptFromIdle(session: Session): boolean {
    return !!session.keepAlive || !!this.holds.get(session.id) || this.idleExemption(session.id);
  }

  private updateExpiry(session: Session): void {
    if (session.status !== "live") {
      session.expiresAt = null;
      return;
    }
    const deadlines: number[] = [];
    if (session.timeout > 0) deadlines.push(Date.parse(session.createdAt) + session.timeout);
    if ((session.idleTimeout ?? 0) > 0 && !this.exemptFromIdle(session)) {
      deadlines.push(
        Date.parse(session.lastActivityAt ?? session.createdAt) + session.idleTimeout!,
      );
    }
    session.expiresAt = deadlines.length ? new Date(Math.min(...deadlines)).toISOString() : null;
  }

  public touch(id: string, _source = "api"): Session | undefined {
    const session = this.sessions.get(id);
    if (!session || this.endings.has(id)) return undefined;
    session.lastActivityAt = new Date().toISOString();
    this.updateExpiry(session);
    return session;
  }

  /** Active server-side jobs exempt idle expiry, but the maximum lifetime still applies. */
  public holdActivity(id: string): () => void {
    if (!this.sessions.has(id)) return () => {};
    this.holds.set(id, (this.holds.get(id) ?? 0) + 1);
    this.touch(id, "job");
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      const count = (this.holds.get(id) ?? 1) - 1;
      if (count > 0) this.holds.set(id, count);
      else this.holds.delete(id);
      this.touch(id, "job");
    };
  }

  public async updateSession(
    id: string,
    patch: Pick<
      StartSessionOptions,
      "name" | "labels" | "timeout" | "idleTimeout" | "keepAlive" | "onExpire"
    >,
  ): Promise<Session> {
    const session = this.getSession(id);
    if (!session) throw new SessionStateError("session_not_found", "Session not found", 404);
    if (this.starts.has(id) || this.endings.has(id))
      throw new SessionStateError("session_busy", "Session is changing state");
    Object.assign(session, patch);
    const options = this.getLaunchOptions(id);
    if (options) Object.assign(options, patch);
    this.updateExpiry(session);
    const snapshot = this.snapshots.get(id);
    if (snapshot && session.status === "parked") {
      Object.assign(snapshot.details, patch);
      await this.store.write(`parked/${id}/meta.json`, snapshot);
    }
    return session;
  }

  public reapExpiredSessions(): Promise<void> {
    if (this.reaping) return this.reaping;
    if (this.closing) return Promise.resolve();
    this.reaping = (async () => {
      const now = Date.now();
      await Promise.all(
        this.listSessions().map(async (session) => {
          if (this.endings.has(session.id) || this.starts.has(session.id)) return;
          this.updateExpiry(session);
          const reason =
            session.timeout > 0 && now - Date.parse(session.createdAt) >= session.timeout
              ? "timeout"
              : (session.idleTimeout ?? 0) > 0 &&
                !this.exemptFromIdle(session) &&
                now - Date.parse(session.lastActivityAt ?? session.createdAt) >=
                  session.idleTimeout!
              ? "idle"
              : undefined;
          if (!reason) return;
          try {
            if (session.onExpire === "park" && !session.isSelenium && !this.parkGuard(session.id))
              await this.parkSession(session.id, reason);
            else await this.endSession(session.id, reason);
          } catch (err) {
            this.logger.error({ err, sessionId: session.id }, "Could not expire session");
          }
        }),
      );
      await this.pruneParked();
      await this.preempt();
    })().finally(() => {
      this.reaping = undefined;
    });
    return this.reaping;
  }

  private async preempt(): Promise<void> {
    const threshold = env.SESSION_PREEMPT_IDLE_MS ?? 0;
    if (!threshold || !this.browserPool.queuedCount) return;
    const candidate = this.listSessions()
      .filter(
        (s) =>
          s.onExpire === "park" &&
          !s.isSelenium &&
          !this.exemptFromIdle(s) &&
          !this.parkGuard(s.id) &&
          Date.now() - Date.parse(s.lastActivityAt ?? s.createdAt) >= threshold,
      )
      .sort(
        (a, b) =>
          Date.parse(a.lastActivityAt ?? a.createdAt) - Date.parse(b.lastActivityAt ?? b.createdAt),
      )[0];
    if (candidate) await this.parkSession(candidate.id, "preempted");
  }

  public async thumbnail(id: string): Promise<Buffer> {
    const session = this.getSession(id);
    if (!session) throw new SessionStateError("session_not_found", "Session not found", 404);
    if (session.status === "parked") return readFile(this.store.path(`parked/${id}/thumbnail.jpg`));
    const cached = this.thumbnails.get(id);
    if (cached && Date.now() - cached.at < 5000) return cached.data;
    const pages = await session.cdpService.getAllPages();
    const page = pages[0];
    if (!page) throw new SessionStateError("no_page", "Session has no page", 404);
    const data = Buffer.from(await page.screenshot({ type: "jpeg", quality: 60 }));
    this.thumbnails.set(id, { at: Date.now(), data });
    return data;
  }

  public async parkSession(
    id: string,
    reason: ParkReason = "manual",
    name?: string,
  ): Promise<SessionDetails> {
    if (this.starts.has(id)) {
      await this.starts.get(id);
      return this.parkSession(id, reason, name);
    }
    if (this.endings.has(id)) return this.endings.get(id)!;
    const session = this.sessions.get(id);
    if (!session) throw new SessionStateError("not_live", "Session is not live");
    if (session.isSelenium)
      throw new SessionStateError("not_parkable", "Selenium sessions cannot be parked");
    if (this.parkGuard(id) && reason !== "shutdown")
      throw new SessionStateError(
        "handoff_waiting",
        "Complete or cancel the human handoff before parking",
      );
    const abort = new AbortController();
    const timer =
      reason === "shutdown"
        ? setTimeout(
            () => abort.abort(new Error("Shutdown parking deadline exceeded")),
            env.SHUTDOWN_PARK_TIMEOUT_MS ?? 20_000,
          )
        : undefined;
    timer?.unref();
    const task = this.parkLiveSession(session, reason, name, abort.signal, () =>
      clearTimeout(timer),
    );
    this.endings.set(id, task);
    try {
      return await task;
    } finally {
      clearTimeout(timer);
      this.endings.delete(id);
      this.transitioning.delete(id);
    }
  }

  private async parkLiveSession(
    session: Session,
    reason: ParkReason,
    name: string | undefined,
    signal: AbortSignal,
    captured: () => void,
  ): Promise<SessionDetails> {
    const capture = async <T>(task: Promise<T>): Promise<T> => {
      signal.throwIfAborted();
      let onAbort: (() => void) | undefined;
      try {
        return await Promise.race([
          task,
          new Promise<never>((_, reject) => {
            onAbort = () => reject(signal.reason);
            signal.addEventListener("abort", onAbort, { once: true });
          }),
        ]);
      } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort);
      }
    };
    const id = session.id;
    const options = this.launchOptions.get(id);
    if (!options?.userDataDir)
      throw new SessionStateError("not_parkable", "Session has no restorable profile");
    const pages = await capture(session.cdpService.getAllPages());
    const tabs: ParkedSnapshot["tabs"] = [];
    for (const page of pages) {
      const state = await capture(
        page
          .evaluate(() => ({
            active: document.visibilityState === "visible",
            scrollX,
            scrollY,
            storage: Object.fromEntries(Object.entries(sessionStorage)),
          }))
          .catch(() => ({ active: false, scrollX: 0, scrollY: 0, storage: {} })),
      );
      tabs.push({ url: page.url(), title: await capture(page.title().catch(() => "")), ...state });
    }
    const cookies = await capture(session.cdpService.getCookies());
    const thumbnail = await capture(this.thumbnail(id).catch(() => undefined));
    const ephemeral = !options.browserProfile;
    const keptProfile = ephemeral ? this.store.path(`parked/${id}/profile`) : options.userDataDir;
    await capture(this.hooks.run("onEnding", session, { reason, park: true }));
    const details: SessionDetails = {
      ...this.serialize(session),
      status: "parked",
      name: name ?? session.name,
      parkedAt: new Date().toISOString(),
      parkReason: reason,
      expiresAt: null,
      slot: -1,
      tabs: tabs.map(({ url, title, active }) => ({ url, title, active })),
    };
    const snapshot: ParkedSnapshot = {
      details,
      options: { ...options, signal: undefined, userDataDir: keptProfile },
      profile: options.userDataDir,
      ephemeral,
      cookies,
      tabs,
    };
    // Persist recovery information before closing Chrome. Never delete its profile on a failed park.
    await this.store.write(`parked/${id}/meta.json`, snapshot);
    if (thumbnail)
      await writeFile(this.store.path(`parked/${id}/thumbnail.jpg`), thumbnail, { mode: 0o600 });
    signal.throwIfAborted();
    captured(); // Allow the remaining shutdown grace for serialized browser teardown.
    this.browserPool.markStopping(id);
    await this.saveProfileCookies(id, session.cdpService);
    await session.cdpService.endSession(ShutdownReason.SESSION_END, !this.closing);
    this.transitioning.set(id, session);
    this.sessions.delete(id);
    session.complete();
    let relocated = !ephemeral || options.userDataDir === keptProfile;
    try {
      if (!relocated) {
        await rename(options.userDataDir, keptProfile).catch(async (err) => {
          if (err.code !== "EXDEV") throw err;
          await cp(options.userDataDir!, keptProfile, { recursive: true });
          await rm(options.userDataDir!, { recursive: true, force: true });
        });
        relocated = true;
      }
    } catch (err) {
      this.logger.error({ err, sessionId: id }, "Parked profile retained at its original path");
    }
    snapshot.profile = relocated ? keptProfile : options.userDataDir;
    snapshot.options.userDataDir = snapshot.profile;
    snapshot.options.persist = options.browserProfile ? options.persist : false;
    snapshot.profileVersion = await this.profileVersion(options.browserProfile);
    for (const [dir, owner] of this.pathOwners) if (owner === id) this.pathOwners.delete(dir);
    if (!options.browserProfile) this.pathOwners.set(path.resolve(snapshot.profile), id);
    for (const entry of [
      "SingletonLock",
      "SingletonSocket",
      "SingletonCookie",
      "Default/Cache",
      "Default/Code Cache",
      "ShaderCache",
      "GrShaderCache",
    ]) {
      await rm(path.join(snapshot.profile, entry), { recursive: true, force: true }).catch(
        () => {},
      );
    }
    await this.store
      .write(`parked/${id}/meta.json`, snapshot)
      .catch((err) =>
        this.logger.error(
          { err, sessionId: id },
          "Park metadata update failed; recovery metadata retained",
        ),
      );
    await session.proxyServer
      ?.close(true)
      .catch((err) => this.logger.warn({ err }, "Parked proxy cleanup failed"));
    Object.assign(session, details, { proxyServer: undefined });
    this.snapshots.set(id, snapshot);
    this.parked.set(id, session);
    this.ephemeralProfiles.delete(id);
    this.launchOptions.delete(id);
    this.holds.delete(id);
    this.unlockProfile(id);
    this.browserPool.release(id);
    await this.hooks.run("onParked", session);
    await this.pruneParked();
    return session;
  }

  private profileVersion(name?: string): Promise<number | undefined> {
    return name
      ? stat(path.join(browserProfilesDir(), name, PROFILE_COOKIES_FILE))
          .then((s) => s.mtimeMs)
          .catch(() => undefined)
      : Promise.resolve(undefined);
  }

  public async resumeSession(
    id: string,
    options: { queueTimeout?: number; signal?: AbortSignal } = {},
  ): Promise<SessionDetails> {
    if (this.sessions.has(id)) return this.sessions.get(id)!;
    const starting = this.starts.get(id);
    if (starting) return starting;
    if (this.endings.has(id))
      throw new SessionStateError("session_busy", "Session is changing state");
    const snapshot = this.snapshots.get(id);
    if (!snapshot || !this.parked.has(id))
      throw new SessionStateError("session_not_found", "Parked session not found", 404);
    return this.startSession({
      ...snapshot.options,
      ...options,
      sessionId: id,
      _resuming: true,
      userDataDir: snapshot.profile,
      sessionContext: undefined,
    });
  }

  private async restoreTabs(
    session: Session,
    snapshot: ParkedSnapshot,
    restoreStorage = true,
  ): Promise<void> {
    const existing = await session.cdpService.getAllPages();
    let active = existing[0];
    for (const [index, tab] of snapshot.tabs.entries()) {
      // Do not reopen privileged or executable URLs from untrusted page state.
      if (!/^https?:\/\//i.test(tab.url) && tab.url !== "about:blank") continue;
      const page = index === 0 && existing[0] ? existing[0] : await session.cdpService.createPage();
      let storageScript: string | undefined;
      if (restoreStorage && /^https?:\/\//i.test(tab.url)) {
        const origin = new URL(tab.url).origin;
        const script = await page.evaluateOnNewDocument(
          (expected, storage) => {
            if (location.origin === expected)
              for (const [key, value] of Object.entries(storage))
                sessionStorage.setItem(key, value);
          },
          origin,
          tab.storage,
        );
        storageScript = script?.identifier;
      }
      try {
        await page
          .goto(tab.url, { waitUntil: "domcontentloaded", timeout: 15_000 })
          .catch(() => undefined);
      } finally {
        // Restore the parked snapshot once. Later navigations must keep changes
        // made by the resumed application instead of replaying stale storage.
        if (storageScript)
          await page.removeScriptToEvaluateOnNewDocument(storageScript).catch(() => undefined);
      }
      await page
        .evaluate((x, y) => scrollTo(x, y), tab.scrollX, tab.scrollY)
        .catch(() => undefined);
      if (tab.active) active = page;
    }
    await active?.bringToFront();
  }

  private serialize(session: Session): SessionDetails {
    const { completion, complete, proxyServer, cdpService, ...details } = session;
    return details;
  }

  private async discardParked(id: string, reason: EndReason): Promise<SessionDetails> {
    const session = this.parked.get(id)!;
    this.parked.delete(id);
    const snapshot = this.snapshots.get(id);
    if (
      snapshot?.ephemeral &&
      !snapshot.options.browserProfile &&
      snapshot.profile !== this.store.path(`parked/${id}/profile`)
    )
      await rm(snapshot.profile, { recursive: true, force: true });
    for (const [dir, owner] of this.pathOwners) if (owner === id) this.pathOwners.delete(dir);
    this.snapshots.delete(id);
    this.thumbnails.delete(id);
    await this.store.remove(`parked/${id}`);
    session.status = "released";
    session.releaseReason = reason;
    session.expiresAt = null;
    this.pastSessions.push(session);
    if (this.pastSessions.length > 100) this.pastSessions.shift();
    await this.hooks.run("onEnded", session);
    return session;
  }

  private async pruneParked(): Promise<void> {
    const ttl = env.PARKED_TTL_MS ?? 604_800_000;
    const max = env.PARKED_MAX ?? 20;
    const ordered = [...this.parked.values()].sort(
      (a, b) =>
        Number(!!a.name) - Number(!!b.name) || Date.parse(a.parkedAt!) - Date.parse(b.parkedAt!),
    );
    for (const session of ordered) {
      if (this.starts.has(session.id) || this.endings.has(session.id)) continue;
      if (this.parked.size > max || (ttl > 0 && Date.now() - Date.parse(session.parkedAt!) >= ttl))
        await this.discardParked(session.id, "parked_expired");
    }
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
