import { EventEmitter } from "events";
import { FastifyBaseLogger } from "fastify";
import {
  BrowserFingerprintWithHeaders,
  FingerprintGenerator,
  FingerprintGeneratorOptions,
  VideoCard,
} from "fingerprint-generator";
import { FingerprintInjector } from "fingerprint-injector";
import fs from "fs";
import { IncomingMessage } from "http";
import httpProxy from "http-proxy";
import os from "os";
import path from "path";
import puppeteer, {
  Browser,
  BrowserContext,
  CDPSession,
  Page,
  Protocol,
  Target,
  TargetType,
} from "puppeteer-core";
import { Duplex } from "stream";
import { env } from "../../env.js";
import { loadFingerprintScript } from "../../scripts/index.js";
import { traceable, tracer } from "../../telemetry/tracer.js";
import { BrowserEventType, BrowserLauncherOptions, EmitEvent } from "../../types/index.js";
import {
  blockReason,
  compileUrlPatterns,
  defaultAdMatcher,
  normalizeHosts,
  type BlockKind,
  type RequestFilter,
} from "../../utils/requests.js";
import {
  createPrivateNetworkCheck,
  parseHostList,
  type PrivateNetworkCheck,
} from "../../utils/private-network.js";
import { filterHeaders, getChromeExecutablePath, installMouseHelper } from "../../utils/browser.js";
import {
  deepMerge,
  extractStorageForPageWithTimeout,
  getProfilePath,
  groupSessionStorageByOrigin,
  handleFrameNavigated,
  injectStorageOnNewDocument,
  safePageUrl,
} from "../../utils/context.js";
import { getExtensionPaths } from "../../utils/extensions.js";
import { RetryManager, RetryOptions } from "../../utils/retry.js";
import { isTargetClosedError } from "../../utils/target-closed.js";
import { publicHost } from "../../utils/url.js";
import { ChromeContextService } from "../context/chrome-context.service.js";
import { SessionData } from "../context/types.js";
import { FileService } from "../file.service.js";
import {
  BaseLaunchError,
  BrowserProcessError,
  BrowserProcessState,
  CleanupError,
  CleanupType,
  FingerprintError,
  FingerprintStage,
  LaunchTimeoutError,
  NetworkError,
  NetworkOperation,
  PluginError,
  PluginName,
  PluginOperation,
  ResourceError,
  ResourceType,
  SessionContextError,
  SessionContextType,
  categorizeError,
} from "./errors/launch-errors.js";
import { BasePlugin, ShutdownReason } from "./plugins/core/base-plugin.js";
import { PluginManager } from "./plugins/core/plugin-manager.js";
import { isSimilarConfig, validateLaunchConfig, validateTimezone } from "./utils/validation.js";
import { TargetInstrumentationManager } from "./instrumentation/target-manager.js";
import {
  createBrowserLogger as createInstrumentationLogger,
  BrowserLogger,
} from "./instrumentation/browser-logger.js";
import { executeBestEffort, executeCritical, executeOptional } from "./utils/error-handlers.js";
import { ProfileInUseError, releaseStaleProfileLock } from "./utils/profile-lock.js";
import { TimezoneFetcher } from "../timezone-fetcher.service.js";

const LAUNCH_TIMEOUT_MS = 60_000;

/**
 * Written to every profile before launch; a session's own `userPreferences` win.
 *
 * `session.restore_on_startup: 5` opens the new tab page. A profile that never
 * chose is treated by recent Chrome (feature SessionRestoreInfobar) as "continue
 * where you left off": each launch then reopens every tab of the previous run
 * and adds its own, so the idle browser, which is relaunched on the same profile
 * after each release, grew by one about:blank per session.
 */
const BASE_PROFILE_PREFERENCES = { session: { restore_on_startup: 5 } };

/** A transparent 1x1 GIF, what a page gets in place of an image that is skipped. */
const EMPTY_IMAGE_BASE64 = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

export class CDPService extends EventEmitter {
  private logger: FastifyBaseLogger;
  private keepAlive: boolean;

  private browserInstance: Browser | null;
  private ownBrowserPid?: number;
  private wsEndpoint: string | null;
  private fingerprintData: BrowserFingerprintWithHeaders | null;
  private sessionContext: SessionData | null;
  private chromeExecPath: string;
  private wsProxyServer: httpProxy;
  private primaryPage: Page | null;
  private downloadSettings: CDPSession | null = null;
  private requestFilterSession: CDPSession | null = null;
  private launchConfig?: BrowserLauncherOptions;
  private defaultLaunchConfig: BrowserLauncherOptions;
  private currentSessionConfig: BrowserLauncherOptions | null;
  private shuttingDown: boolean;
  private shutdownPromise?: Promise<void>;
  private defaultTimezone: string;
  private pluginManager: PluginManager;
  private trackedOrigins: Set<string> = new Set<string>();
  private crashedPages: WeakSet<Page> = new WeakSet<Page>();
  private emulationSessions: WeakMap<Page, CDPSession> = new WeakMap<Page, CDPSession>();
  private chromeSessionService: ChromeContextService;
  private retryManager: RetryManager;
  private targetInstrumentationManager: TargetInstrumentationManager;
  private instrumentationLogger: BrowserLogger;

  private blockedHosts: string[] = [];
  private compiledUrlPatterns: RegExp[] = [];
  private pageSetups = new Map<string, Promise<void>>();
  private launchQueue: Promise<unknown> = Promise.resolve();
  private launchMutators: ((config: BrowserLauncherOptions) => Promise<void> | void)[] = [];
  private shutdownMutators: ((config: BrowserLauncherOptions | null) => Promise<void> | void)[] =
    [];
  private proxyWebSocketHandler:
    | ((req: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void>)
    | null = null;
  private disconnectHandler: () => Promise<void> = () => this.endSession();
  public readonly cdpPort: number;
  /**
   * The primary browser (pool slot 0) keeps the stock behaviour: an idle browser
   * is always running and the shared files directory is cleaned on launch and
   * shutdown. Secondary slots only run Chrome while a session owns them and
   * leave the shared files directory alone.
   */
  public readonly primary: boolean;

  constructor(
    config: { keepAlive?: boolean; cdpPort?: number; primary?: boolean },
    logger: FastifyBaseLogger,
    storage?: any,
    enableConsoleLogging?: boolean,
  ) {
    super();
    this.logger = logger.child({ component: "CDPService" });
    const { keepAlive = true, cdpPort = 9222, primary = true } = config;
    this.cdpPort = cdpPort;
    this.primary = primary;

    this.keepAlive = keepAlive;
    this.browserInstance = null;
    this.wsEndpoint = null;
    this.fingerprintData = null;
    this.sessionContext = null;
    this.chromeExecPath = getChromeExecutablePath();
    this.defaultTimezone = env.DEFAULT_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.trackedOrigins = new Set<string>();
    this.chromeSessionService = new ChromeContextService(logger);
    this.retryManager = new RetryManager(logger);

    this.wsProxyServer = httpProxy.createProxyServer();

    this.wsProxyServer.on("error", (err) => {
      this.logger.error(`Proxy server error: ${err}`);
    });

    this.primaryPage = null;
    this.currentSessionConfig = null;
    this.shuttingDown = false;

    // Initialize timezone fetcher for cold start
    const timezoneFetcher = new TimezoneFetcher(logger);
    const coldStartTimezone = timezoneFetcher.getTimezone(undefined, this.defaultTimezone);

    this.defaultLaunchConfig = {
      options: {
        headless: env.CHROME_HEADLESS,
        args: [],
        ignoreDefaultArgs: ["--enable-automation"],
      },
      blockAds: true,
      extensions: [],
      userDataDir: env.CHROME_USER_DATA_DIR || path.join(os.tmpdir(), "steel-chrome"),
      timezone: coldStartTimezone,
      userPreferences: {
        plugins: {
          always_open_pdf_externally: true,
          plugins_disabled: ["Chrome PDF Viewer"],
        },
      },
      deviceConfig: { device: "desktop" },
    };

    this.pluginManager = new PluginManager(this, logger);

    this.instrumentationLogger = createInstrumentationLogger({
      baseLogger: this.logger,
      initialContext: {},
      storage: storage || null,
      enableConsoleLogging: enableConsoleLogging ?? true,
    });
    this.targetInstrumentationManager = new TargetInstrumentationManager(
      this.instrumentationLogger,
      this.logger,
      undefined,
      this.pluginManager.onTargetSession.bind(this.pluginManager),
    );
    this.instrumentationLogger?.on?.(EmitEvent.Log, (event, context) => {
      this.emit(EmitEvent.Log, event);
    });
    this.logger.info("[CDPService] Target instrumentation enabled");
  }

  public getInstrumentationLogger(): BrowserLogger {
    return this.instrumentationLogger;
  }

  public getWsEndpoint(): string | null {
    return this.wsEndpoint;
  }

  public getLogger(name: string) {
    return this.logger.child({ component: name });
  }

  public setChromeExecPath(execPath: string): void {
    this.chromeExecPath = execPath;
  }

  public setProxyWebSocketHandler(
    handler: ((req: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void>) | null,
  ): void {
    this.proxyWebSocketHandler = handler;
  }

  public setDisconnectHandler(handler: () => Promise<void>): void {
    this.disconnectHandler = handler;
  }

  public getBrowserInstance(): Browser | null {
    return this.browserInstance;
  }

  public getLaunchConfig(): BrowserLauncherOptions | undefined {
    return this.launchConfig;
  }

  public getSessionContext(): SessionData | null {
    return this.sessionContext;
  }

  public registerLaunchHook(fn: (config: BrowserLauncherOptions) => Promise<void> | void) {
    this.launchMutators.push(fn);
  }

  public registerShutdownHook(fn: (config: BrowserLauncherOptions | null) => Promise<void> | void) {
    this.shutdownMutators.push(fn);
  }

  private removeAllHandlers() {
    this.browserInstance?.removeAllListeners();
    // Keep this emitter's own listeners: they are the UI's log/pageId sockets,
    // which must keep receiving events after the browser is relaunched.
  }

  public isRunning(): boolean {
    const browser = this.browserInstance;
    const process = browser?.process();
    return (
      !!browser?.connected && !!process && process.exitCode === null && process.signalCode === null
    );
  }

  public getTargetId(page: Page) {
    //@ts-ignore
    return page.target()._targetId;
  }

  public async getPrimaryPage(): Promise<Page> {
    if (!this.primaryPage || !this.browserInstance) {
      throw new Error("CDPService has not been launched yet!");
    }
    if (this.primaryPage.isClosed()) {
      this.primaryPage = await this.browserInstance.newPage();
    }
    return this.primaryPage;
  }

  private getDebuggerBase(): { baseUrl: string; protocol: string; wsProtocol: string } {
    const baseUrl =
      env.CDP_DOMAIN ?? env.DOMAIN ?? `${publicHost(env.HOST)}:${env.CDP_REDIRECT_PORT}`;
    const protocol = env.USE_SSL ? "https" : "http";
    const wsProtocol = env.USE_SSL ? "wss" : "ws";
    return { baseUrl, protocol, wsProtocol };
  }

  public getDebuggerUrl() {
    const { baseUrl, protocol } = this.getDebuggerBase();
    return `${protocol}://${baseUrl}/devtools/devtools_app.html`;
  }

  public getDebuggerWsUrl(pageId?: string) {
    const { baseUrl, wsProtocol } = this.getDebuggerBase();
    return `${wsProtocol}://${baseUrl}/devtools/page/${
      pageId ?? this.getTargetId(this.primaryPage!)
    }`;
  }

  public async refreshPrimaryPage(signal?: AbortSignal) {
    const previous = this.primaryPage;
    const isCurrent = () => !signal?.aborted && this.primaryPage === previous;
    const newPage = await this.createPage();
    if (isCurrent() && previous && !previous.isClosed()) {
      // Notify plugins before page close
      await this.pluginManager.onBeforePageClose(previous);
    }
    if (!isCurrent()) {
      await newPage.close().catch(() => {});
      return;
    }
    this.primaryPage = newPage;
    if (previous && !previous.isClosed()) {
      await previous.close();
    }
  }

  public registerPlugin(plugin: BasePlugin) {
    return this.pluginManager.register(plugin);
  }

  public unregisterPlugin(pluginName: string) {
    return this.pluginManager.unregister(pluginName);
  }

  private async handleTargetChange(target: Target) {
    if (target.type() !== "page") return;

    const page = await target.page().catch((e) => {
      this.logger.error(`Error handling target change in CDPService: ${e}`);
      return null;
    });

    if (page) {
      this.pluginManager.onPageNavigate(page);

      //@ts-ignore
      const pageId = page.target()._targetId;

      // Track the origin of the page
      try {
        const url = page.url();
        if (url && url.startsWith("http")) {
          const origin = new URL(url).origin;
          this.trackedOrigins.add(origin);
          this.logger.debug(`[CDPService] Tracking new origin: ${origin}`);
        }
      } catch (err) {
        this.logger.error(`[CDPService] Error tracking origin: ${err}`);
      }

      this.emit(EmitEvent.PageId, { pageId });
    }
  }

  private setUpTarget(target: Target): Promise<void> {
    const targetId = (target as any)._targetId as string;
    const setup: Promise<void> = this.handleNewTarget(target)
      .catch((error) => {
        if (isTargetClosedError(error)) {
          this.logger.debug(
            { err: error },
            "[CDPService] Target closed while handling targetcreated",
          );
          return;
        }
        this.logger.error({ err: error }, "[CDPService] Unhandled error in handleNewTarget");
      })
      .finally(() => {
        if (this.pageSetups.get(targetId) === setup) {
          this.pageSetups.delete(targetId);
        }
      });
    this.pageSetups.set(targetId, setup);
    return setup;
  }

  public async waitForPageSetup(page: Page): Promise<void> {
    await this.pageSetups.get(this.getTargetId(page));
  }

  private async handleNewTarget(target: Target) {
    if (target.type() === TargetType.PAGE) {
      this.queueMobileEmulation(target);
    }

    try {
      await this.targetInstrumentationManager.attach(target, target.type() as TargetType);
    } catch (error) {
      if (isTargetClosedError(error)) {
        this.logger.debug(
          { err: error },
          "[CDPService] Target closed while attaching instrumentation",
        );
        return;
      }
      this.logger.error({ err: error }, `[CDPService] Error attaching target instrumentation`);
    }

    if (target.type() === TargetType.PAGE) {
      const page = await target.page().catch((e) => {
        if (isTargetClosedError(e)) {
          this.logger.debug({ err: e }, "[CDPService] Target closed before page handle was ready");
          return null;
        }
        this.logger.error(`Error handling new target in CDPService: ${e}`);
        return null;
      });

      if (!page || page.isClosed()) {
        return;
      }

      // Puppeteer emits "error" when the renderer for this page crashes. The browser
      // process survives, so CDP calls against the page hang instead of rejecting.
      page.on("error", (err) => {
        this.crashedPages.add(page);
        this.logger.error({ err, url: safePageUrl(page) }, "[CDPService] Page renderer crashed");
      });

      try {
        try {
          const url = page.url();
          if (url && url.startsWith("http")) {
            const origin = new URL(url).origin;
            this.trackedOrigins.add(origin);
            this.logger.debug(`[CDPService] Tracking new origin: ${origin}`);
          }
        } catch (err) {
          this.logger.error(`[CDPService] Error tracking origin: ${err}`);
        }

        // Notify plugins about the new page
        await this.pluginManager.onPageCreated(page);

        if (page.isClosed()) {
          return;
        }

        // Only install mouse helper in headless mode
        if (
          this.launchConfig?.options?.headless &&
          this.getCompatibilityState().mode === "legacy"
        ) {
          await installMouseHelper(page, this.launchConfig?.deviceConfig?.device || "desktop");
        }

        if (this.launchConfig?.customHeaders) {
          await page.setExtraHTTPHeaders({
            ...env.DEFAULT_HEADERS,
            ...this.launchConfig.customHeaders,
          });
        } else if (env.DEFAULT_HEADERS) {
          await page.setExtraHTTPHeaders(env.DEFAULT_HEADERS);
        }

        await this.applyDeviceMetricsOverride(page);

        // Inject fingerprint only if it's not skipped
        if (this.isFingerprintInjectionEnabled()) {
          // Use our safer fingerprint injection method instead of FingerprintInjector
          await this.injectFingerprintSafely(page, this.fingerprintData);
          this.logger.debug("[CDPService] Injected fingerprint into page");
        } else {
          this.logger.info(
            "[CDPService] Fingerprint injection skipped due to 'SKIP_FINGERPRINT_INJECTION' setting",
          );
        }

        if (page.isClosed()) {
          return;
        }

        // Ads, saveData and operator rules are filtered once for the whole browser
        // (applyRequestFilter); a page only needs its file:// guard.
        await this.blockFileRequests(page);

        page.on("response", (response) => {
          if (response.url().startsWith("file://")) {
            this.logger.error(
              `[CDPService] Blocked response from file protocol: ${response.url()}`,
            );
            page.close().catch(() => {});
            this.endSession(ShutdownReason.SECURITY_VIOLATION);
          }
        });
      } catch (error) {
        if (isTargetClosedError(error) || page.isClosed()) {
          this.logger.debug(
            { err: error },
            "[CDPService] Target closed while configuring a new page",
          );
          return;
        }
        this.logger.error({ err: error }, "[CDPService] Error configuring new page");
      }
    } else if (target.type() === TargetType.BACKGROUND_PAGE) {
      this.logger.info(`[CDPService] Background page created: ${target.url()}`);
    }
  }

  private async blockFileRequests(page: Page) {
    const session = await page.createCDPSession();
    session.on("Fetch.requestPaused", (event: Protocol.Fetch.RequestPausedEvent) => {
      this.logger.error(`[CDPService] Blocked request to file protocol: ${event.request.url}`);
      session
        .send("Fetch.failRequest", { requestId: event.requestId, errorReason: "AccessDenied" })
        .catch(() => {});
      page.close().catch(() => {});
      this.endSession(ShutdownReason.SECURITY_VIOLATION);
    });
    await session.send("Fetch.enable", {
      patterns: [{ urlPattern: "file://*", requestStage: "Request" }],
    });
  }

  private requiresRequestInterception(): boolean {
    if (
      this.launchConfig?.blockAds ||
      this.launchConfig?.blockPrivateNetwork ||
      this.compiledUrlPatterns.length > 0
    ) {
      return true;
    }

    const optimize = this.launchConfig?.optimizeBandwidth;
    if (!optimize || typeof optimize === "boolean") {
      return optimize === true;
    }

    return Boolean(
      optimize.blockImages ||
        optimize.blockMedia ||
        optimize.blockFonts ||
        optimize.blockStylesheets ||
        optimize.blockHosts?.length ||
        optimize.blockUrlPatterns?.length,
    );
  }

  /**
   * Turns the session's request filter (blockAds, optimizeBandwidth and so
   * saveData) on or off for the running browser.
   *
   * It intercepts on the browser target, not on each page: a page created and
   * navigated by a CDP client in one go would otherwise load before a per-page
   * interception is in place. One Chrome serves one session, so the filter
   * never reaches another session's browser.
   */
  private async applyRequestFilter(): Promise<void> {
    const previous = this.requestFilterSession;
    this.requestFilterSession = null;
    // Chrome lets the requests a detached interceptor still held go through.
    if (previous) await previous.detach().catch(() => {});
    if (!this.browserInstance || !this.requiresRequestInterception()) return;

    const optimize = this.launchConfig?.optimizeBandwidth;
    const flags = typeof optimize === "object" ? optimize : undefined;
    const filter: RequestFilter = {
      ads: this.launchConfig?.blockAds ? defaultAdMatcher() : undefined,
      hosts: this.blockedHosts,
      urlPatterns: this.compiledUrlPatterns,
      images: !!flags?.blockImages,
      media: !!flags?.blockMedia,
      fonts: !!flags?.blockFonts,
      stylesheets: !!flags?.blockStylesheets,
    };
    const onBlocked = this.launchConfig?.onRequestBlocked;
    const privateNetwork = this.launchConfig?.blockPrivateNetwork
      ? createPrivateNetworkCheck({ allowHosts: parseHostList(env.PRIVATE_NETWORK_ALLOW_HOSTS) })
      : undefined;
    const session = await this.browserInstance.target().createCDPSession();
    session.on("Fetch.requestPaused", (event: Protocol.Fetch.RequestPausedEvent) => {
      void this.handlePausedRequest(session, event, filter, onBlocked, privateNetwork);
    });
    await session.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
    });
    this.requestFilterSession = session;
  }

  private async handlePausedRequest(
    session: CDPSession,
    event: Protocol.Fetch.RequestPausedEvent,
    filter: RequestFilter,
    onBlocked?: (kind: BlockKind, url: string) => void,
    privateNetwork?: PrivateNetworkCheck,
  ) {
    const url = event.request.url;
    let reason: BlockKind | undefined;
    try {
      // Every request, the document a tab navigates to included: a popup's
      // first request and each hop of a redirect are paused here like the rest.
      // The session's own extensions keep talking to the API beside the browser.
      const origin = event.request.headers?.Origin ?? event.request.headers?.origin ?? "";
      if (
        privateNetwork &&
        !origin.startsWith("chrome-extension://") &&
        (await privateNetwork(url))
      )
        reason = "private";
    } catch (error) {
      this.logger.debug({ err: error }, `[CDPService] Could not check the address of ${url}`);
      reason = "private";
    }
    try {
      const resourceType = (event.resourceType ?? "Other").toLowerCase();
      // A page target carries the id of its main frame.
      const pageTarget = this.browserInstance
        ?.targets()
        .find((target) => target.type() === "page" && this.getTargetIdOf(target) === event.frameId);
      const headers = event.request.headers ?? {};
      reason ??= blockReason(
        {
          url,
          resourceType,
          mainFrameNavigation: resourceType === "document" && !!pageTarget,
          pageUrl: pageTarget?.url(),
          referrer: headers.Referer ?? headers.referer,
        },
        filter,
      );
    } catch (error) {
      this.logger.debug({ err: error }, `[CDPService] Could not classify request ${url}`);
    }

    try {
      if (reason) {
        this.logger.debug(`[CDPService] Blocked request (${reason}): ${url}`);
        if (reason === "images") {
          // A skipped image is answered with an empty one, not refused: pages
          // that swap in a placeholder on error ask for it again on every
          // refusal, thousands of times a minute, and never finish loading.
          await session.send("Fetch.fulfillRequest", {
            requestId: event.requestId,
            responseCode: 200,
            responseHeaders: [
              { name: "content-type", value: "image/gif" },
              { name: "cache-control", value: "max-age=3600" },
              { name: "access-control-allow-origin", value: "*" },
            ],
            body: EMPTY_IMAGE_BASE64,
          });
        } else {
          // The page sees what an ad blocker produces: net::ERR_BLOCKED_BY_CLIENT.
          await session.send("Fetch.failRequest", {
            requestId: event.requestId,
            errorReason: "BlockedByClient",
          });
        }
        try {
          onBlocked?.(reason, url);
        } catch (error) {
          this.logger.debug({ err: error }, "[CDPService] Blocked request observer failed");
        }
      } else {
        await session.send("Fetch.continueRequest", { requestId: event.requestId });
      }
    } catch (error) {
      // The request went away with its page, or the browser is closing.
      if (isTargetClosedError(error)) return;
      this.logger.debug(
        { err: error },
        `[CDPService] Could not resolve intercepted request ${url}`,
      );
    }
  }

  private getTargetIdOf(target: Target): string | undefined {
    return (target as any)._targetId as string | undefined;
  }

  public async createPage(): Promise<Page> {
    if (!this.browserInstance) {
      throw new Error("Browser instance not initialized");
    }
    return this.browserInstance.newPage();
  }

  private async shutdownHook() {
    for (const mutator of this.shutdownMutators) {
      await mutator(this.currentSessionConfig);
    }
  }

  @traceable
  public async shutdown(reason: ShutdownReason): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    const task = this.shutdownBrowser(reason);
    this.shutdownPromise = task;
    try {
      await task;
    } finally {
      this.shutdownPromise = undefined;
    }
  }

  private async shutdownBrowser(reason: ShutdownReason): Promise<void> {
    this.shuttingDown = true;
    this.chromeSessionService.invalidate();
    this.logger.info(`[CDPService] Shutting down browser (reason: ${reason})`);
    try {
      if (this.browserInstance) await this.pluginManager.onBrowserClose(this.browserInstance);
      await this.pluginManager.onShutdown(reason);
      await this.closeBrowserProcess();
      // Puppeteer uses browser listeners to finish graceful shutdown and flush profile data.
      this.removeAllHandlers();
      await this.shutdownHook();
      this.fingerprintData = null;
      this.currentSessionConfig = null;
      this.requestFilterSession = null;
      this.browserInstance = null;
      this.wsEndpoint = null;
      this.emit("close");
    } catch (error) {
      this.logger.error({ err: error }, "Browser shutdown failed");
      // Keep the instance available for the caller's explicit cleanup attempt.
      throw error;
    } finally {
      this.shuttingDown = false;
    }
  }

  private async closeBrowserProcess(): Promise<void> {
    const browser = this.browserInstance;
    if (!browser) return;
    const child = browser.process();
    const exited = () => !child || child.exitCode !== null || child.signalCode !== null;
    const waitForExit = async (milliseconds: number): Promise<boolean> => {
      if (exited()) return true;
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          child!.off("exit", done);
          resolve(exited());
        };
        const timer = setTimeout(done, milliseconds);
        child!.once("exit", done);
        if (exited()) done();
      });
    };
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        browser.close(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Graceful browser close timed out")), 10_000);
        }),
      ]);
    } catch (err) {
      this.logger.warn({ err }, "Graceful browser close failed; terminating its process");
    } finally {
      clearTimeout(timer);
    }
    if (!exited()) {
      child!.kill("SIGTERM");
      if (!(await waitForExit(3000))) {
        child!.kill("SIGKILL");
        if (!(await waitForExit(2000)))
          throw new Error("Browser process did not exit; slot must remain unavailable");
      }
    }
    if (!child && browser.connected) throw new Error("Browser is still connected after shutdown");
  }

  public getPageCount(): number {
    return this.browserInstance?.targets().filter((target) => target.type() === "page").length ?? 0;
  }

  public getPid(): number | undefined {
    return this.browserInstance?.process()?.pid;
  }

  public getBrowserProcess() {
    return this.browserInstance?.process() || null;
  }

  public async createBrowserContext(proxyUrl: string): Promise<BrowserContext> {
    if (!this.browserInstance) {
      throw new Error("Browser instance not initialized");
    }
    return this.browserInstance.createBrowserContext({ proxyServer: proxyUrl });
  }

  @traceable
  public async launch(
    config?: BrowserLauncherOptions,
    retryOptions?: Partial<RetryOptions>,
  ): Promise<Browser> {
    const operation = async () => {
      try {
        return await this.launchInternal(config);
      } catch (error) {
        try {
          await this.pluginManager.onShutdown(ShutdownReason.LAUNCH_FAILURE);
          await this.shutdownHook();
        } catch (e) {
          this.logger.warn(
            `[CDPService] Error during retry cleanup (onShutdown/shutdownHook): ${e}`,
          );
        }
        throw error;
      }
    };

    // Use retry mechanism for the launch process
    const launched = this.launchQueue.then(() =>
      this.retryManager.executeWithRetry(operation, "Browser Launch", retryOptions),
    );
    this.launchQueue = launched.catch(() => undefined);
    const result = await launched;

    return result.result;
  }

  @traceable
  private async launchInternal(config?: BrowserLauncherOptions): Promise<Browser> {
    const abandon = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      const launchTimeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abandon.abort(new LaunchTimeoutError(LAUNCH_TIMEOUT_MS));
          reject(abandon.signal.reason);
        }, LAUNCH_TIMEOUT_MS);
      });

      const launchProcess = (async () => {
        const shouldReuseInstance =
          this.browserInstance &&
          (await isSimilarConfig(this.launchConfig, config || this.defaultLaunchConfig));
        abandon.signal.throwIfAborted();

        if (shouldReuseInstance) {
          this.logger.info(
            "[CDPService] Reusing existing browser instance with default configuration.",
          );
          this.launchConfig = config || this.defaultLaunchConfig;
          this.currentSessionConfig = this.launchConfig;

          const reuseOptimize = this.launchConfig.optimizeBandwidth;
          const reusePatterns =
            typeof reuseOptimize === "object" ? reuseOptimize.blockUrlPatterns : undefined;
          this.compiledUrlPatterns = reusePatterns?.length ? compileUrlPatterns(reusePatterns) : [];
          const reuseHosts =
            typeof reuseOptimize === "object" ? reuseOptimize.blockHosts : undefined;
          this.blockedHosts = reuseHosts?.length ? normalizeHosts(reuseHosts) : [];
          await executeBestEffort(
            this.logger,
            async () => this.applyRequestFilter(),
            "Failed to install the request filter",
          );

          await executeCritical(
            async () => this.refreshPrimaryPage(),
            (error) =>
              new BrowserProcessError(
                "Failed to refresh primary page when reusing browser instance",
                BrowserProcessState.PAGE_REFRESH,
                error,
              ),
          );

          // Session context injection - should throw error if it fails
          if (this.launchConfig?.sessionContext) {
            this.logger.debug(
              `[CDPService] Session created with session context, injecting session context`,
            );
            await executeCritical(
              async () =>
                this.injectSessionContext(this.primaryPage!, this.launchConfig!.sessionContext!),
              (error) => {
                const contextError = new SessionContextError(
                  error instanceof Error ? error.message : String(error),
                  SessionContextType.CONTEXT_INJECTION,
                  error,
                );
                this.logger.warn(`[CDPService] ${contextError.message} - throwing error`);
                return contextError;
              },
            );
          }
          if (!this.shuttingDown && this.browserInstance) {
            await this.pluginManager.onBrowserReady(this.launchConfig);
          } else {
            this.logger.warn(
              `[CDPService] Skipping onBrowserReady: shuttingDown=${
                this.shuttingDown
              }, browserInstance=${!!this.browserInstance}`,
            );
          }

          return this.browserInstance!;
        } else if (this.browserInstance) {
          this.logger.info(
            "[CDPService] Existing browser instance detected. Closing it before launching a new one.",
          );
          await executeBestEffort(
            this.logger,
            async () => this.shutdown(ShutdownReason.RELAUNCH),
            "Error during shutdown before launch",
          );
          abandon.signal.throwIfAborted();
        }

        this.launchConfig = config || this.defaultLaunchConfig;

        const optimize = this.launchConfig.optimizeBandwidth;
        const rawPatterns = typeof optimize === "object" ? optimize.blockUrlPatterns : undefined;
        this.compiledUrlPatterns = rawPatterns?.length ? compileUrlPatterns(rawPatterns) : [];
        const rawHosts = typeof optimize === "object" ? optimize.blockHosts : undefined;
        this.blockedHosts = rawHosts?.length ? normalizeHosts(rawHosts) : [];

        this.logger.info("[CDPService] Launching new browser instance.");

        // Validate configuration
        await executeCritical(
          async () => validateLaunchConfig(this.launchConfig!),
          (error) => categorizeError(error, "configuration validation"),
        );

        // File cleanup - non-critical, log errors but continue
        this.logger.info("[CDPService] Cleaning up files before browser launch");
        await executeOptional(
          this.logger,
          async () => {
            // Session files have independent retention; never erase another session here.
            this.logger.info("[CDPService] Files cleaned successfully before launch");
          },
          (error) =>
            new CleanupError(
              error instanceof Error ? error.message : String(error),
              CleanupType.PRE_LAUNCH_FILE_CLEANUP,
              error,
            ),
        );

        const { options, userAgent, userDataDir, fingerprint } = this.launchConfig;
        this.compatibilityFallbacks.clear();
        this.fingerprintData = fingerprint ?? null;

        // Run launch mutators - plugin errors should be caught
        await executeCritical(
          async () => {
            for (const mutator of this.launchMutators) {
              await mutator(this.launchConfig!);
            }
          },
          (error) =>
            new PluginError(
              error instanceof Error ? error.message : String(error),
              PluginName.LAUNCH_MUTATOR,
              PluginOperation.PRE_LAUNCH_HOOK,
              true,
              error,
            ),
        );

        // Fingerprint generation - can fail gracefully
        if (
          this.isFingerprintInjectionEnabled() &&
          !userAgent &&
          !this.launchConfig.skipFingerprintInjection &&
          !this.fingerprintData
        ) {
          await executeCritical(
            async () => {
              let fingerprintOptions: Partial<FingerprintGeneratorOptions> = {
                devices: ["desktop"],
                operatingSystems: ["linux"],
                browsers: [{ name: "chrome", minVersion: 146 }],
                locales: ["en-US", "en"],
                screen: {
                  minWidth: this.launchConfig!.dimensions?.width ?? 1920,
                  minHeight: this.launchConfig!.dimensions?.height ?? 1080,
                  maxWidth: this.launchConfig!.dimensions?.width ?? 1920,
                  maxHeight: this.launchConfig!.dimensions?.height ?? 1080,
                },
              };

              if (this.launchConfig!.deviceConfig?.device === "mobile") {
                fingerprintOptions = {
                  devices: ["mobile"],
                  locales: ["en-US", "en"],
                };
              }

              // fingerprint-generator's bundled dataset lags the latest Chrome
              // release, so a hardcoded newest-Chrome `minVersion` (and/or the
              // tight `screen` box) can leave zero matching samples and make
              // getFingerprint() throw deterministically. Prefer the strict
              // options for best stealth, but relax progressively rather than
              // hard-fail when the dataset cannot satisfy them.
              const fallbackOptions: Array<Partial<FingerprintGeneratorOptions>> = [
                fingerprintOptions,
                { ...fingerprintOptions, browsers: [{ name: "chrome" }] },
                { ...fingerprintOptions, browsers: [{ name: "chrome" }], screen: undefined },
              ];
              let fingerprintErr: unknown;
              for (const options of fallbackOptions) {
                try {
                  this.fingerprintData = new FingerprintGenerator(options).getFingerprint();
                  if (options !== fingerprintOptions) {
                    this.logger.warn(
                      { requested: fingerprintOptions, used: options },
                      "[CDPService] Strict fingerprint constraints unsatisfiable in the bundled dataset; generated with relaxed constraints",
                    );
                  }
                  break;
                } catch (err) {
                  fingerprintErr = err;
                }
              }
              if (!this.fingerprintData) {
                throw fingerprintErr;
              }
            },
            (error) => {
              this.logger.error({ err: error }, "[CDPService] Error generating fingerprint");
              return new FingerprintError(
                error instanceof Error ? error.message : String(error),
                FingerprintStage.GENERATION,
                error,
              );
            },
          );
        } else if (this.fingerprintData) {
          this.logger.info(
            `[CDPService] Using existing fingerprint with user agent: ${this.fingerprintData.fingerprint.navigator.userAgent}`,
          );
        }

        const isHeadless = !!this.launchConfig?.options?.headless;

        this.currentSessionConfig = {
          ...this.launchConfig,
          dimensions: this.launchConfig.dimensions || this.fingerprintData?.fingerprint.screen,
          userAgent:
            this.launchConfig.userAgent || this.fingerprintData?.fingerprint.navigator.userAgent,
        };

        const extensionPaths = await executeCritical(
          async () => {
            const defaultExtensions = isHeadless && env.RRWEB_RECORDING ? ["recorder"] : [];
            const customExtensions = this.launchConfig!.extensions
              ? [...this.launchConfig!.extensions]
              : [];

            // Get named extension paths
            const namedExtensionPaths = await getExtensionPaths([
              ...defaultExtensions,
              ...customExtensions,
            ]);

            // Check for session extensions passed from the API
            let sessionExtensionPaths: string[] = [];
            if (this.launchConfig!.extra?.orgExtensions?.paths) {
              sessionExtensionPaths = this.launchConfig!.extra.orgExtensions.paths;
              this.logger.info(
                `[CDPService] Found ${sessionExtensionPaths.length} session extension paths`,
              );
            }

            return [...namedExtensionPaths, ...sessionExtensionPaths];
          },
          (error) =>
            new ResourceError(
              `Failed to resolve extension paths: ${error}`,
              ResourceType.EXTENSIONS,
              false,
              error,
            ),
        );

        let timezone = this.defaultTimezone;
        if (config?.timezone) {
          const validatedTimezone = await executeOptional(
            this.logger,
            async () => {
              const tz = await validateTimezone(this.logger, config.timezone!);
              this.logger.info(`Resolved and validated timezone: ${tz}`);
              return tz;
            },
            (error) => {
              this.logger.warn(`Timezone validation failed, using fallback`);
              return categorizeError(error, "timezone validation");
            },
            this.defaultTimezone,
          );
          timezone = validatedTimezone ?? this.defaultTimezone;
        }

        const extensionArgs = extensionPaths.length
          ? [
              `--load-extension=${extensionPaths.join(",")}`,
              `--disable-extensions-except=${extensionPaths.join(",")}`,
            ]
          : [];

        const shouldDisableSandbox =
          env.DISABLE_CHROME_SANDBOX ||
          (typeof process.getuid === "function" && process.getuid() === 0);

        const staticDefaultArgs = [
          "--remote-allow-origins=*",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--disable-features=TranslateUI,BlinkGenPropertyTrees,LinuxNonClientFrame,PermissionPromptSurvey,IsolateOrigins,site-per-process,TouchpadAndWheelScrollLatching,TrackingProtection3pcd,InterestFeedContentSuggestions,PrivacySandboxSettings4,AutofillServerCommunication,OptimizationHints,MediaRouter,DialMediaRouteProvider,CertificateTransparencyComponentUpdater,GlobalMediaControls,AudioServiceOutOfProcess,LazyFrameLoading,AvoidUnnecessaryBeforeUnloadCheckSync,DisableLoadExtensionCommandLineSwitch,DisableDisableExtensionsExceptCommandLineSwitch,SessionRestoreInfobar",
          "--enable-features=Clipboard",
          "--no-default-browser-check",
          "--disable-sync",
          "--disable-translate",
          "--no-first-run",
          "--disable-search-engine-choice-screen",
          "--webrtc-ip-handling-policy=disable_non_proxied_udp",
          "--force-webrtc-ip-handling-policy",
          "--disable-touch-editing",
          "--disable-touch-drag-drop",
          "--disable-client-side-phishing-detection",
          "--disable-default-apps",
          "--disable-component-update",
          "--disable-infobars",
          "--disable-breakpad",
          "--disable-background-networking",
          "--disable-session-crashed-bubble",
          "--disable-ipc-flooding-protection",
          "--disable-popup-blocking",
          "--disable-prompt-on-repost",
          "--disable-domain-reliability",
          "--metrics-recording-only",
          "--no-pings",
          "--disable-backing-store-limit",
          "--password-store=basic",
          ...(shouldDisableSandbox
            ? ["--no-sandbox", "--disable-setuid-sandbox", "--no-zygote"]
            : []),
        ];

        const headfulArgs = [
          "--ozone-platform=x11",
          "--disable-renderer-backgrounding",
          "--disable-backgrounding-occluded-windows",
          "--use-gl=swiftshader",
          "--in-process-gpu",
          "--enable-crashpad",
          "--crash-dumps-dir=/tmp/chrome-dumps",
          "--noerrdialogs",
          "--force-device-scale-factor=1",
          "--disable-hang-monitor",
        ];

        const headlessArgs = [
          "--headless=new",
          "--hide-crash-restore-bubble",
          ...(this.launchConfig?.compatibilityMode === "native"
            ? []
            : ["--disable-blink-features=AutomationControlled"]),
          // can we just remove this outright?
          `--unsafely-treat-insecure-origin-as-secure=http://localhost:3000,http://${env.HOST}:${env.PORT}`,
        ];

        const dynamicArgs = [
          this.launchConfig.dimensions ? "" : "--start-maximized",
          // External clients must use the authenticated, lease-fenced API broker.
          "--remote-debugging-address=127.0.0.1",
          `--remote-debugging-port=${this.cdpPort}`,
          `--window-size=${this.launchConfig.dimensions?.width ?? 1920},${
            this.launchConfig.dimensions?.height ?? 1080
          }`,
          userAgent ? `--user-agent=${userAgent}` : "",
          this.launchConfig.options.proxyUrl
            ? `--proxy-server=${this.launchConfig.options.proxyUrl}`
            : "",
          this.launchConfig.fullscreen === true ? "--kiosk" : "",
        ];

        const uniq = (xs: string[]) => Array.from(new Set(xs.filter(Boolean)));

        const launchArgs = uniq([
          ...staticDefaultArgs,
          ...(isHeadless ? headlessArgs : headfulArgs),
          ...dynamicArgs,
          ...extensionArgs,
          ...(options.args || []),
          ...(env.CHROME_ARGS || []),
        ]).filter((arg) => !env.FILTER_CHROME_ARGS.includes(arg));

        const finalLaunchOptions = {
          ...options,
          handleSIGINT: false,
          handleSIGTERM: false,
          handleSIGHUP: false,
          defaultViewport: null,
          args: launchArgs,
          executablePath: this.chromeExecPath,
          ignoreDefaultArgs: [
            ...(this.launchConfig?.compatibilityMode === "native" ? [] : ["--enable-automation"]),
            ...(extensionPaths.length ? ["--disable-extensions"] : []),
          ],
          timeout: LAUNCH_TIMEOUT_MS,
          env: {
            HOME: os.userInfo().homedir,
            TZ: timezone,
            // Without a UTF-8 character type Chrome cannot write a file name
            // with an accent: it saves every such download as "download",
            // each one over the last.
            LC_CTYPE: "C.UTF-8",
            ...(isHeadless ? {} : { DISPLAY: env.DISPLAY }),
          },
          userDataDir,
          dumpio: env.DEBUG_CHROME_PROCESS, // Enable Chrome process stdout and stderr
        };

        this.logger.info(`[CDPService] Launch Options:`);
        this.logger.info(JSON.stringify(finalLaunchOptions, null, 2));

        if (userDataDir) {
          await this.releaseProfileLock(userDataDir);
          abandon.signal.throwIfAborted();
        }

        if (userDataDir) {
          this.logger.info(`[CDPService] Setting up user preferences in ${userDataDir}`);
          await executeBestEffort(
            this.logger,
            async () =>
              this.setupUserPreferences(
                userDataDir,
                deepMerge(BASE_PROFILE_PREFERENCES, this.launchConfig!.userPreferences ?? {}),
              ),
            "Failed to set up user preferences",
          );
        }

        abandon.signal.throwIfAborted();

        // Browser process launch - most critical step
        const browser = await executeCritical(
          async () =>
            (await tracer.startActiveSpan("CDPService.launchBrowser", async () => {
              return await puppeteer.launch(finalLaunchOptions);
            })) as unknown as Browser,
          (error) =>
            new BrowserProcessError(
              error instanceof Error ? error.message : String(error),
              BrowserProcessState.LAUNCH_FAILED,
              error,
            ),
        );
        if (abandon.signal.aborted) {
          this.logger.warn(
            "[CDPService] Closing browser launched after its launch attempt timed out",
          );
          await browser.close().catch(() => undefined);
          browser.process()?.kill();
          abandon.signal.throwIfAborted();
        }
        this.browserInstance = browser;
        this.ownBrowserPid = browser.process()?.pid;

        // Plugin notifications - catch individual plugin errors
        await executeOptional(
          this.logger,
          async () => this.pluginManager.onBrowserLaunch(this.browserInstance!),
          (error) =>
            new PluginError(
              error instanceof Error ? error.message : String(error),
              PluginName.PLUGIN_MANAGER,
              PluginOperation.BROWSER_LAUNCH_NOTIFICATION,
              true,
              error,
            ),
        );

        this.browserInstance.on("error", (err) => {
          this.logger.error(`[CDPService] Browser error: ${err}`);
          const error = err as Error;
          this.instrumentationLogger.record({
            type: BrowserEventType.BrowserError,
            error: { message: error?.message, stack: error?.stack },
            timestamp: new Date().toISOString(),
          });
        });

        this.primaryPage = await executeCritical(
          async () => (await this.browserInstance!.pages())[0],
          (error) =>
            new BrowserProcessError(
              "Failed to get primary page from browser instance",
              BrowserProcessState.PAGE_ACCESS,
              error,
            ),
        );

        // Session context injection - should throw error if it fails
        if (this.launchConfig?.sessionContext) {
          this.logger.debug(
            `[CDPService] Session created with session context, injecting session context`,
          );
          await executeCritical(
            async () =>
              this.injectSessionContext(this.primaryPage!, this.launchConfig!.sessionContext!),
            (error) => {
              const contextError = new SessionContextError(
                error instanceof Error ? error.message : String(error),
                SessionContextType.CONTEXT_INJECTION,
                error,
              );
              this.logger.warn(`[CDPService] ${contextError.message} - throwing error`);
              return contextError;
            },
          );
        }

        // Configure browser download behavior
        await executeBestEffort(
          this.logger,
          async () => {
            const downloadPath =
              this.launchConfig?.downloadPath ?? FileService.getInstance().getBaseFilesPath();
            const cdpSession = await this.browserInstance!.target().createCDPSession();
            await cdpSession.send("Browser.setDownloadBehavior", {
              behavior: "allow",
              downloadPath: downloadPath,
              eventsEnabled: true,
            });
            this.downloadSettings = cdpSession;
            this.logger.debug(
              `[CDPService] Download behavior configured with path: ${downloadPath}`,
            );
          },
          "Failed to configure download behavior",
        );

        // In place before any page of the session can navigate.
        await executeBestEffort(
          this.logger,
          async () => this.applyRequestFilter(),
          "Failed to install the request filter",
        );

        this.browserInstance.on("targetcreated", (target) => {
          void this.setUpTarget(target);
        });
        this.browserInstance.on("targetchanged", this.handleTargetChange.bind(this));
        this.browserInstance.on("targetdestroyed", (target) => {
          const targetId = (target as any)._targetId;
          this.targetInstrumentationManager.detach(targetId);
        });
        this.browserInstance.on("disconnected", this.onDisconnect.bind(this));

        this.wsEndpoint = await executeCritical(
          async () => this.browserInstance!.wsEndpoint(),
          (error) =>
            new NetworkError(
              "Failed to get WebSocket endpoint from browser",
              NetworkOperation.WEBSOCKET_SETUP,
              error,
            ),
        );

        // Final setup steps
        await executeOptional(
          this.logger,
          async () => {
            await this.handleNewTarget(this.primaryPage!.target());
            await this.handleTargetChange(this.primaryPage!.target());
          },
          (error) =>
            new BrowserProcessError(
              error instanceof Error ? error.message : String(error),
              BrowserProcessState.TARGET_SETUP,
              error,
            ),
        );

        try {
          const existingTargets = await this.browserInstance.targets();
          for (const target of existingTargets) {
            if ((target as any)._targetId !== (this.primaryPage.target() as any)._targetId) {
              await this.targetInstrumentationManager.attach(target, target.type() as TargetType);
            }
          }
          this.logger.info(
            `[CDPService] Attached instrumentation to ${existingTargets.length} existing targets`,
          );
        } catch (error) {
          this.logger.error({ err: error }, `[CDPService] Error attaching to existing targets`);
        }

        if (!this.shuttingDown && this.browserInstance) {
          await this.pluginManager.onBrowserReady(this.launchConfig);
        } else {
          this.logger.warn(
            `[CDPService] Skipping onBrowserReady: shuttingDown=${
              this.shuttingDown
            }, browserInstance=${!!this.browserInstance}`,
          );
        }

        return this.browserInstance;
      })();

      return (await Promise.race([launchProcess, launchTimeout])) as Browser;
    } catch (error: unknown) {
      const categorizedError =
        error instanceof BaseLaunchError ? error : categorizeError(error, "browser launch");

      this.logger.error(
        {
          error: {
            errorType: categorizedError.type,
            isRetryable: categorizedError.isRetryable,
            context: categorizedError.context,
          },
        },
        `[CDPService] LAUNCH ERROR (${categorizedError.type}): ${categorizedError.message}`,
      );

      throw categorizedError;
    } finally {
      clearTimeout(timer);
    }
  }

  @traceable
  public async proxyWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (this.proxyWebSocketHandler) {
      this.logger.info("[CDPService] Using custom WebSocket proxy handler");
      await this.proxyWebSocketHandler(req, socket, head);
      return;
    }

    if (!this.wsEndpoint) {
      throw new Error(`WebSocket endpoint not available. Ensure the browser is launched first.`);
    }

    const cleanupListeners = () => {
      this.browserInstance?.off("close", cleanupListeners);
      if (this.browserInstance?.process()) {
        this.browserInstance.process()?.off("close", cleanupListeners);
      }
      this.browserInstance?.off("disconnected", cleanupListeners);
      socket.off("close", cleanupListeners);
      socket.off("error", cleanupListeners);
      this.logger.info("[CDPService] WebSocket connection listeners cleaned up");
    };

    this.browserInstance?.once("close", cleanupListeners);
    if (this.browserInstance?.process()) {
      this.browserInstance.process()?.once("close", cleanupListeners);
    }
    this.browserInstance?.once("disconnected", cleanupListeners);
    socket.once("close", cleanupListeners);
    socket.once("error", cleanupListeners);

    // Increase max listeners
    if (this.browserInstance?.process()) {
      this.browserInstance.process()!.setMaxListeners(60);
    }

    this.wsProxyServer.ws(
      req,
      socket,
      head,
      {
        target: this.wsEndpoint,
        changeOrigin: true,
      },
      (error) => {
        if (error) {
          this.logger.error(`WebSocket proxy error: ${error}`);
          cleanupListeners(); // Clean up on error too
        }
      },
    );

    socket.on("error", (error) => {
      this.logger.error(`Socket error: ${error}`);
      // Try to end the socket properly on error
      try {
        socket.end();
      } catch (e) {
        this.logger.error(`Error ending socket: ${e}`);
      }
    });
  }

  public getUserAgent() {
    return (
      this.currentSessionConfig?.userAgent || this.fingerprintData?.fingerprint.navigator.userAgent
    );
  }

  public getDimensions() {
    return this.currentSessionConfig?.dimensions || { width: 1920, height: 1080 };
  }

  private compatibilityFallbacks = new Set<string>();

  public getCompatibilityState() {
    const mode =
      this.launchConfig?.skipFingerprintInjection || env.SKIP_FINGERPRINT_INJECTION
        ? "native"
        : this.launchConfig?.compatibilityMode ?? "legacy";
    return {
      mode,
      version: 1,
      patches:
        mode === "native"
          ? []
          : [
              {
                id: "cdp-identity",
                version: 1,
                apis: ["User-Agent", "Client Hints", "Accept-Language", "viewport", "touch"],
              },
              ...(mode === "legacy"
                ? [
                    {
                      id: "legacy-script",
                      version: 1,
                      apis: ["navigator", "WebGL", "Worker", "console", "Object reflection"],
                      status: "legacy-unverified",
                    },
                  ]
                : []),
            ],
      fallbacks: [...this.compatibilityFallbacks],
      runtime: {
        defaultGpuDisabled: !env.FILTER_CHROME_ARGS.includes("--disable-gpu"),
        headless: this.launchConfig?.options?.headless ?? true,
        automationControlledFlag:
          this.launchConfig?.compatibilityMode !== "native" &&
          !!this.launchConfig?.options?.headless,
      },
      limits: [
        "No guarantee of site acceptance",
        "Host fonts, graphics, codecs and worker capabilities remain host-dependent",
      ],
    };
  }

  public getFingerprintData(): BrowserFingerprintWithHeaders | null {
    return this.fingerprintData;
  }

  public async getCookies(): Promise<Protocol.Network.Cookie[]> {
    if (!this.browserInstance) {
      throw new Error("Browser not initialized");
    }
    const session = await this.browserInstance.target().createCDPSession();
    try {
      const { cookies } = await session.send("Storage.getCookies");
      return cookies;
    } finally {
      await session.detach().catch(() => undefined);
    }
  }

  /**
   * Returns the browser version reported by the running browser instance,
   * e.g. `Chrome/150.0.7871.124`. Returns an empty string when no browser is
   * running or the version cannot be resolved.
   */
  public async getBrowserVersion(): Promise<string> {
    if (!this.browserInstance) {
      return "";
    }
    try {
      return await this.browserInstance.version();
    } catch (error) {
      this.logger.warn(`[CDPService] Failed to resolve browser version: ${error}`);
      return "";
    }
  }

  public async getBrowserState(): Promise<SessionData> {
    if (!this.browserInstance || !this.primaryPage) {
      throw new Error("Browser or primary page not initialized");
    }

    const userDataDir = this.launchConfig?.userDataDir;

    if (!userDataDir) {
      this.logger.warn("No userDataDir specified, returning empty session data");
      return {};
    }

    try {
      this.logger.info(`[CDPService] Dumping session data from userDataDir: ${userDataDir}`);

      // Run session data extraction and CDP storage extraction in parallel
      const [cookieData, sessionData, storageData] = await Promise.all([
        this.getCookies(),
        this.chromeSessionService.getSessionData(userDataDir),
        this.getExistingPageSessionData(),
      ]);

      // Merge storage data with session data
      const result = {
        cookies: cookieData,
        localStorage: {
          ...(sessionData.localStorage || {}),
          ...(storageData.localStorage || {}),
        },
        sessionStorage: {
          ...(sessionData.sessionStorage || {}),
          ...(storageData.sessionStorage || {}),
        },
        indexedDB: {
          ...(sessionData.indexedDB || {}),
          ...(storageData.indexedDB || {}),
        },
      };

      this.logger.info("[CDPService] Session data dumped successfully");
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`[CDPService] Error dumping session data: ${errorMessage}`);
      return {};
    }
  }

  /**
   * Extract all storage data (localStorage, sessionStorage, IndexedDB) for all open pages
   */
  private async getExistingPageSessionData(): Promise<SessionData> {
    if (!this.browserInstance || !this.primaryPage) {
      return {};
    }

    const result: SessionData = {
      localStorage: {},
      sessionStorage: {},
      indexedDB: {},
    };

    try {
      const pages = await this.browserInstance.pages();

      let crashedCount = 0;
      const validPages = pages.filter((page) => {
        try {
          if (this.crashedPages.has(page)) {
            crashedCount++;
            return false;
          }
          const url = page.url();
          return url && url.startsWith("http");
        } catch (e) {
          return false;
        }
      });

      this.logger.info(
        `[CDPService] Processing ${validPages.length} valid pages out of ${pages.length} total for storage extraction` +
          (crashedCount > 0 ? ` (skipped ${crashedCount} crashed)` : ""),
      );

      const results = await Promise.all(
        validPages.map((page) => extractStorageForPageWithTimeout(page, this.logger)),
      );

      // Merge all results
      for (const item of results) {
        for (const domain in item.localStorage) {
          result.localStorage![domain] = {
            ...(result.localStorage![domain] || {}),
            ...item.localStorage![domain],
          };
        }

        for (const domain in item.sessionStorage) {
          result.sessionStorage![domain] = {
            ...(result.sessionStorage![domain] || {}),
            ...item.sessionStorage![domain],
          };
        }

        for (const domain in item.indexedDB) {
          result.indexedDB![domain] = [
            ...(result.indexedDB![domain] || []),
            ...item.indexedDB![domain],
          ];
        }
      }

      return result;
    } catch (error) {
      this.logger.error(`[CDPService] Error extracting storage with CDP: ${error}`);
      return result;
    }
  }

  public async getAllPages() {
    return this.browserInstance?.pages() || [];
  }

  @traceable
  public async startNewSession(sessionConfig: BrowserLauncherOptions): Promise<Browser> {
    // Keep shutdown hooks bound to the outgoing browser. launchInternal assigns
    // the incoming config only after teardown (or when reusing the browser), so
    // incoming metadata cannot affect cleanup of the previous browser instance.
    this.trackedOrigins.clear(); // Clear tracked origins when starting a new session

    // Recreate target instrumentation manager with session-specific options
    this.targetInstrumentationManager = new TargetInstrumentationManager(
      this.instrumentationLogger,
      this.logger,
      {
        dangerouslyLogRequestDetails: sessionConfig.dangerouslyLogRequestDetails,
        captureWorkerNetwork: sessionConfig.captureWorkerNetwork,
      },
      this.pluginManager.onTargetSession.bind(this.pluginManager),
    );

    // Notify plugins that a session is starting, before any launch/reuse work begins.
    // This is the earliest point where session context (e.g. sessionId) is available.
    await this.pluginManager.onSessionStart(sessionConfig);

    try {
      return await this.launch(sessionConfig);
    } catch (error) {
      // If launch fails, ensure we still notify plugins about session end to allow for proper cleanup
      await this.pluginManager.onBeforeSessionEnd(sessionConfig);
      await this.pluginManager.onSessionEnd(sessionConfig);
      await this.pluginManager.onAfterSessionEnd(sessionConfig);
      throw error;
    }
  }

  @traceable
  public async endSession(
    reason: ShutdownReason = ShutdownReason.SESSION_END,
    relaunchIdle = true,
  ): Promise<void> {
    this.logger.info("Ending current session and resetting to default configuration.");
    const sessionConfig = this.currentSessionConfig!;

    this.sessionContext = await this.getBrowserState().catch(() => null);

    try {
      await this.pluginManager.onBeforeSessionEnd(sessionConfig);
      await this.shutdown(reason);
      await this.pluginManager.onSessionEnd(sessionConfig);
      this.currentSessionConfig = null;
      this.sessionContext = null;
      this.trackedOrigins.clear();

      this.instrumentationLogger.resetContext();

      // Reset target instrumentation manager to clear session-specific options
      // (e.g. dangerous logging flags) so they don't leak into the idle browser
      this.targetInstrumentationManager = new TargetInstrumentationManager(
        this.instrumentationLogger,
        this.logger,
        undefined,
        this.pluginManager.onTargetSession.bind(this.pluginManager),
      );
    } finally {
      await this.pluginManager.onAfterSessionEnd(sessionConfig);
    }

    // Relaunch the idle browser (secondary pool slots stay down until reused)
    if (this.primary && relaunchIdle) {
      await this.launch(this.defaultLaunchConfig);
    }
  }

  private async onDisconnect(): Promise<void> {
    this.logger.info("Browser disconnected. Handling cleanup.");

    if (this.shuttingDown) {
      return;
    }

    await this.disconnectHandler();
  }

  @traceable
  private async injectSessionContext(
    page: Page,
    context?: BrowserLauncherOptions["sessionContext"],
  ) {
    if (!context) return;

    const storageByOrigin = groupSessionStorageByOrigin(context);

    for (const origin of storageByOrigin.keys()) {
      this.trackedOrigins.add(origin);
    }

    const client = await page.createCDPSession();
    try {
      if (context.cookies?.length) {
        await client.send("Network.setCookies", {
          cookies: context.cookies.map((cookie) => ({
            ...cookie,
            partitionKey: cookie.partitionKey as unknown as Protocol.Network.Cookie["partitionKey"],
          })),
        });
        this.logger.info(`[CDPService] Set ${context.cookies.length} cookies`);
      }
    } catch (error) {
      this.logger.error(`[CDPService] Error setting cookies: ${error}`);
    } finally {
      await client.detach().catch(() => {});
    }

    this.logger.info(
      `[CDPService] Registered frame navigation handler for ${storageByOrigin.size} origins`,
    );
    page.on("framenavigated", (frame) => handleFrameNavigated(frame, storageByOrigin, this.logger));
    await injectStorageOnNewDocument(page, storageByOrigin);

    page.browser().on("targetcreated", async (target) => {
      if (target.type() === "page") {
        try {
          const newPage = await target.page();
          if (newPage) {
            newPage.on("framenavigated", (frame) =>
              handleFrameNavigated(frame, storageByOrigin, this.logger),
            );
            await injectStorageOnNewDocument(newPage, storageByOrigin);
          }
        } catch (err) {
          this.logger.error(`[CDPService] Error adding framenavigated handler to new page: ${err}`);
        }
      }
    });

    this.logger.debug("[CDPService] Session context injection setup complete");
  }

  @traceable
  private async injectFingerprintSafely(
    page: Page,
    fingerprintData: BrowserFingerprintWithHeaders | null,
  ) {
    if (!fingerprintData) return;

    try {
      const { fingerprint, headers } = fingerprintData;
      const userAgentMetadata = fingerprint.navigator.userAgentData;
      const { isMobile, navigatorPlatform, uaPlatform, override } =
        this.buildUserAgentOverride(fingerprintData);

      if (isMobile || this.getCompatibilityState().mode === "compatible") {
        await page.setUserAgent(override.userAgent, override.userAgentMetadata);
      } else {
        await page.setUserAgent(override.userAgent);
      }

      await this.withEmulationSession(
        page,
        isMobile || this.getCompatibilityState().mode === "compatible",
        async (session) => {
          await page.setExtraHTTPHeaders(filterHeaders(headers));
          await session.send("Emulation.setUserAgentOverride", override);
        },
      );

      // Compatible mode uses browser-supported CDP overrides only. It deliberately
      // leaves console, reflection, graphics and Worker constructors untouched.
      if (this.getCompatibilityState().mode === "compatible") return;
      await page.evaluateOnNewDocument(
        loadFingerprintScript({
          fixedPlatform: navigatorPlatform,
          fixedUaPlatform: uaPlatform,
          fixedMobile: Boolean(userAgentMetadata.mobile),
          fixedVendor: (fingerprint.videoCard as VideoCard | null)?.vendor,
          fixedRenderer: (fingerprint.videoCard as VideoCard | null)?.renderer,
          fixedDeviceMemory: fingerprint.navigator.deviceMemory || 8,
          fixedHardwareConcurrency: fingerprint.navigator.hardwareConcurrency || 8,
          fixedArchitecture: userAgentMetadata.architecture ?? "x86",
          fixedBitness: userAgentMetadata.bitness ?? "64",
          fixedModel: userAgentMetadata.model ?? "",
          fixedPlatformVersion: userAgentMetadata.platformVersion ?? "15.0.0",
          fixedUaFullVersion: userAgentMetadata.uaFullVersion || "131.0.6778.86",
          fixedBrands:
            userAgentMetadata.brands ||
            ([] as unknown as Array<{
              brand: string;
              version: string;
            }>),
        }),
      );
    } catch (error) {
      if (isTargetClosedError(error) || page.isClosed()) {
        this.logger.debug({ err: error }, "[Fingerprint] Skipping injection; target closed");
        return;
      }
      this.logger.error({ error }, `[Fingerprint] Error injecting fingerprint safely`);
      if (this.getCompatibilityState().mode !== "legacy") throw error;
      this.compatibilityFallbacks.add("fingerprint-injector@2.1.82");
      const fingerprintInjector = new FingerprintInjector();
      // @ts-ignore - Ignore type mismatch between puppeteer versions
      await fingerprintInjector.attachFingerprintToPuppeteer(page, fingerprintData);
    }
  }

  @traceable
  private async applyDeviceMetricsOverride(page: Page): Promise<void> {
    if (!this.isFingerprintInjectionEnabled()) return;
    const screen = this.fingerprintData?.fingerprint?.screen;
    if (!screen) {
      this.logger.warn(
        "[CDPService] No fingerprint screen data available, skipping Page.setDeviceMetricsOverride",
      );
      return;
    }

    const isMobile = this.isMobileUserAgent(this.getUserAgent());
    const { metrics, touch } = this.buildDeviceMetrics(screen, isMobile);
    const persist =
      (isMobile || this.getCompatibilityState().mode === "compatible") &&
      this.isFingerprintInjectionEnabled();
    await this.withEmulationSession(page, persist, async (session) => {
      await session.send("Page.setDeviceMetricsOverride", metrics);
      if (touch) {
        await session.send("Emulation.setTouchEmulationEnabled", touch);
      }
    });
  }

  private queueMobileEmulation(target: Target): void {
    const fingerprintData = this.fingerprintData;
    const session = (target as any)._session?.() as CDPSession | undefined;
    if (!fingerprintData || !session) return;
    const { screen, navigator } = fingerprintData.fingerprint;
    if (!screen || !this.isMobileUserAgent(navigator.userAgent)) return;
    if (!this.isFingerprintInjectionEnabled()) return;

    const { metrics, touch } = this.buildDeviceMetrics(screen, true);
    const sent = [
      session.send("Page.setDeviceMetricsOverride", metrics),
      ...(touch ? [session.send("Emulation.setTouchEmulationEnabled", touch)] : []),
      ...(navigator.userAgentData
        ? [
            session.send(
              "Emulation.setUserAgentOverride",
              this.buildUserAgentOverride(fingerprintData).override,
            ),
          ]
        : []),
    ];
    void Promise.all(sent).catch((err) => {
      this.logger.debug({ err }, "[CDPService] Early mobile emulation did not apply");
    });
  }

  private buildUserAgentOverride(fingerprintData: BrowserFingerprintWithHeaders) {
    const { fingerprint, headers } = fingerprintData;
    const userAgent = fingerprint.navigator.userAgent;
    const userAgentMetadata = fingerprint.navigator.userAgentData;
    const isMobile = this.isMobileUserAgent(userAgent);
    const navigatorPlatform = fingerprint.navigator.platform || "Linux x86_64";
    const uaPlatform = userAgentMetadata.platform || navigatorPlatform;
    const acceptLanguage = headers["accept-language"]
      ?.split(",")
      .map((language) => language.split(";")[0].trim())
      .filter(Boolean)
      .join(",");
    const override: Protocol.Emulation.SetUserAgentOverrideRequest & {
      userAgentMetadata: Protocol.Emulation.UserAgentMetadata;
    } = {
      userAgent,
      acceptLanguage,
      platform: isMobile ? navigatorPlatform : uaPlatform,
      userAgentMetadata: {
        brands:
          userAgentMetadata.brands as unknown as Protocol.Emulation.UserAgentMetadata["brands"],
        fullVersionList:
          userAgentMetadata.fullVersionList as unknown as Protocol.Emulation.UserAgentMetadata["fullVersionList"],
        fullVersion: userAgentMetadata.uaFullVersion,
        platform: uaPlatform,
        platformVersion: userAgentMetadata.platformVersion ?? "",
        architecture: userAgentMetadata.architecture ?? "x86",
        model: userAgentMetadata.model ?? "",
        mobile: userAgentMetadata.mobile as unknown as boolean,
        bitness: userAgentMetadata.bitness ?? "64",
        wow64: false, // wow64 property doesn't exist on UserAgentData, defaulting to false
        ...(isMobile
          ? ({ formFactors: [userAgentMetadata.mobile ? "Mobile" : "Desktop"] } as object)
          : {}),
      },
    };
    return { isMobile, navigatorPlatform, uaPlatform, override };
  }

  private buildDeviceMetrics(
    screen: {
      width: number;
      height: number;
      devicePixelRatio: number;
      innerWidth?: number;
      innerHeight?: number;
    },
    isMobile: boolean,
  ): {
    metrics: Protocol.Page.SetDeviceMetricsOverrideRequest;
    touch: Protocol.Emulation.SetTouchEmulationEnabledRequest | null;
  } {
    const maxTouchPoints =
      (this.fingerprintData?.fingerprint.navigator as { maxTouchPoints?: number } | undefined)
        ?.maxTouchPoints ?? 1;
    return {
      metrics: {
        screenWidth: screen.width,
        screenHeight: screen.height,
        width: screen.innerWidth || screen.width,
        height: screen.innerHeight || screen.height,
        mobile: isMobile,
        screenOrientation:
          screen.height > screen.width
            ? { angle: 0, type: "portraitPrimary" }
            : { angle: 90, type: "landscapePrimary" },
        deviceScaleFactor: screen.devicePixelRatio,
      },
      touch: isMobile ? { enabled: true, maxTouchPoints } : null,
    };
  }

  private isFingerprintInjectionEnabled(): boolean {
    return (
      this.launchConfig?.compatibilityMode !== "native" &&
      !env.SKIP_FINGERPRINT_INJECTION &&
      !this.launchConfig?.skipFingerprintInjection
    );
  }

  private isMobileUserAgent(userAgent: string | null | undefined): boolean {
    return /phone|android|mobile/i.test(userAgent ?? "");
  }

  private async withEmulationSession(
    page: Page,
    persist: boolean,
    apply: (session: CDPSession) => Promise<void>,
  ): Promise<void> {
    if (!persist) {
      const session = await page.createCDPSession();
      try {
        await apply(session);
      } finally {
        await session.detach().catch(() => {});
      }
      return;
    }

    let session = this.emulationSessions.get(page);
    if (!session) {
      session = await page.createCDPSession();
      this.emulationSessions.set(page, session);
    }
    await apply(session);
  }

  private async releaseProfileLock(userDataDir: string) {
    try {
      const result = await releaseStaleProfileLock(userDataDir, this.ownBrowserPid);
      if (result.status === "cleared") {
        this.logger.info(
          `[CDPService] Removed stale profile lock left by PID ${result.pid} in ${userDataDir}`,
        );
      } else if (result.status === "stopped") {
        this.logger.warn(
          `[CDPService] Stopped Chrome PID ${result.pid} that was still holding ${userDataDir}`,
        );
      } else if (result.status === "skipped") {
        this.logger.info(
          `[CDPService] Left profile lock in ${userDataDir} as is: ${result.reason}`,
        );
      }
    } catch (error) {
      if (error instanceof ProfileInUseError) {
        throw new ResourceError(error.message, ResourceType.PROFILE, false, error);
      }
      this.logger.warn(`[CDPService] Could not release profile lock in ${userDataDir}: ${error}`);
    }
  }

  @traceable
  private async setupUserPreferences(userDataDir: string, userPreferences: Record<string, any>) {
    try {
      const preferencesPath = getProfilePath(userDataDir, "Preferences");
      const defaultProfileDir = path.dirname(preferencesPath);

      await fs.promises.mkdir(defaultProfileDir, { recursive: true });

      let existingPreferences = {};

      try {
        const existingContent = await fs.promises.readFile(preferencesPath, "utf8");
        existingPreferences = JSON.parse(existingContent);
      } catch (error) {
        this.logger.debug(`[CDPService] No existing preferences found, creating new: ${error}`);
      }

      const mergedPreferences = deepMerge(existingPreferences, userPreferences);

      await fs.promises.writeFile(preferencesPath, JSON.stringify(mergedPreferences, null, 2));

      this.logger.info(`[CDPService] User preferences written to ${preferencesPath}`);
    } catch (error) {
      this.logger.error(`[CDPService] Error setting up user preferences: ${error}`);
      throw error;
    }
  }
}
