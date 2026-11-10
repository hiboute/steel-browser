import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { Page } from "puppeteer-core";
import { boundedRegex } from "./watchers-regex.js";
import {
  type Session,
  type StartSessionOptions,
  BROWSER_PROFILE_NAME,
  browserProfilesDir,
  PROFILE_FINGERPRINT_FILE,
} from "./session.service.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserFingerprintWithHeaders } from "fingerprint-generator";
import {
  CookieLibraryService,
  CookieSetConflictError,
  CookieCheckResult,
  CookieFingerprint,
  summarize,
} from "./cookie-library.service.js";

interface HealthDependencies {
  runJob<T>(
    kind: string,
    options: { sessionOptions: StartSessionOptions; timeoutMs: number },
    fn: (session: Session) => Promise<T>,
  ): Promise<T | undefined>;
  notify(message: {
    event: string;
    severity: "info" | "warning" | "error";
    title: string;
    message: string;
    data?: Record<string, unknown>;
  }): Promise<unknown>;
  warn(error: unknown): void;
}
export type CookieCheckOutcome =
  | { set: ReturnType<typeof summarize>; result: CookieCheckResult }
  | { skipped: true; reason: "pool_busy" };

export function inCheckWindow(window: string, now = new Date()): boolean {
  if (!window) return true;
  const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(window);
  if (
    !match ||
    Number(match[1]) > 23 ||
    Number(match[3]) > 23 ||
    Number(match[2]) > 59 ||
    Number(match[4]) > 59
  )
    throw new Error("COOKIE_CHECK_WINDOW must be empty or HH:MM-HH:MM in UTC");
  const start = Number(match[1]) * 60 + Number(match[2]),
    end = Number(match[3]) * 60 + Number(match[4]);
  const current = now.getUTCHours() * 60 + now.getUTCMinutes();
  return (
    start === end ||
    (start < end ? current >= start && current < end : current >= start || current < end)
  );
}

/** Uses separate, capacity-limited browser jobs, never a user's live browser. */
export class CookieHealthService {
  private checks = new Map<string, Promise<CookieCheckOutcome>>();
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private closing = false;
  constructor(
    private library: CookieLibraryService,
    private deps: HealthDependencies,
    private config = { warnDays: 3, window: "", settleMs: 2000 },
  ) {
    inCheckWindow(config.window);
  }
  start() {
    if (this.timer || this.closing) return;
    this.timer = setInterval(() => void this.tick().catch(this.deps.warn), 10 * 60_000);
    this.timer.unref();
    void this.tick().catch(this.deps.warn);
  }
  stop() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  async check(name: string, client = "anonymous"): Promise<CookieCheckOutcome> {
    await this.library.assertAccess(name, client);
    return this.checkAuthorized(name, client);
  }
  private async checkAuthorized(name: string, client: string): Promise<CookieCheckOutcome> {
    if (this.closing)
      throw new CookieSetConflictError("Cookie checker is shutting down", "shutting_down");
    const existing = this.checks.get(name);
    if (existing) return existing;
    const task = this.runCheck(name, client);
    this.checks.set(name, task);
    try {
      return await task;
    } finally {
      this.checks.delete(name);
    }
  }
  private async runCheck(name: string, client: string): Promise<CookieCheckOutcome> {
    const set = await this.library.get(name);
    if (!set.check)
      throw new CookieSetConflictError("Cookie set has no login check configured", "no_check");
    const check = set.check;
    const identity = set.pinFingerprint !== false ? set.fingerprint ?? {} : {};
    const result = await this.deps.runJob(
      "cookie-check",
      {
        timeoutMs: 50_000,
        sessionOptions: {
          ...identity,
          credentials: {},
          sessionContext: { cookies: set.cookies, localStorage: set.localStorage },
          egress: set.egress,
          client: "system:cookie-health",
          cookieSetWriteBack: false,
        } as StartSessionOptions,
      },
      async (session) => {
        const started = Date.now();
        let page: Page | undefined;
        let outcome: CookieCheckResult;
        try {
          page =
            (await session.cdpService.getAllPages())[0] ??
            (await session.cdpService.getBrowserInstance()?.newPage());
          if (!page) throw new Error("Browser has no page for login check");
          const response = await page.goto(check.url, {
            waitUntil: "domcontentloaded",
            timeout: 25_000,
          });
          await new Promise((resolve) => setTimeout(resolve, this.config.settleMs));
          const finalUrl = page.url();
          const failedStatus = response && response.status() >= 400;
          const state = await page.evaluate(
            ({ loggedInSelector, loggedOutSelector, textIncludes }) => ({
              loggedIn: !loggedInSelector || !!document.querySelector(loggedInSelector),
              loggedOut: !!loggedOutSelector && !!document.querySelector(loggedOutSelector),
              text: !textIncludes || (document.body?.innerText ?? "").includes(textIncludes),
            }),
            check,
          );
          const loggedOutUrl =
            !!check.loggedOutUrlPattern &&
            (await boundedRegex(check.loggedOutUrlPattern, finalUrl)) !== null;
          const reason = failedStatus
            ? `HTTP ${response!.status()}`
            : loggedOutUrl
            ? "logged_out_url"
            : state.loggedOut
            ? "logged_out_selector"
            : !state.loggedIn
            ? "logged_in_selector_missing"
            : !state.text
            ? "expected_text_missing"
            : "logged_in";
          outcome = {
            ok: reason === "logged_in",
            reason,
            finalUrl,
            durationMs: Date.now() - started,
          };
          if (outcome.ok) {
            try {
              const state = await session.cdpService.getBrowserState();
              // CDP includes freshly written session cookies that the profile DB may not have flushed.
              state.cookies = await session.cdpService.getCookies();
              const write = await this.library.writeBack(name, state);
              if (write.updated)
                await this.library.audit("cookieset.writeback", {
                  client,
                  subject: name,
                  sessionId: session.id,
                  detail: { source: "health_check" },
                });
            } catch (error) {
              this.deps.warn(error);
            }
          }
        } catch (error) {
          outcome = {
            ok: false,
            reason: error instanceof Error ? error.message.slice(0, 300) : "check_failed",
            finalUrl: page?.url() ?? check.url,
            durationMs: Date.now() - started,
          };
        }
        const saved = await this.library.recordHealth(name, outcome);
        await this.library.audit("cookieset.check", {
          client,
          subject: name,
          sessionId: session.id,
          detail: { ok: outcome.ok, reason: outcome.reason, durationMs: outcome.durationMs },
        });
        this.library.changed(name, "cookieset.check");
        const prior = saved.previous?.lastResult?.ok;
        if (prior !== undefined && prior !== outcome.ok) {
          await this.deps.notify({
            event: outcome.ok ? "cookieset.recovered" : "cookieset.failing",
            severity: outcome.ok ? "info" : "warning",
            title: outcome.ok ? `Login restored: ${name}` : `Login needs attention: ${name}`,
            message: outcome.ok
              ? "The login check is passing again."
              : `The login check failed: ${outcome.reason}`,
            data: { cookieSet: name },
          });
        }
        return { set: summarize(saved.set, Date.now(), this.config.warnDays), result: outcome };
      },
    );
    return result ?? { skipped: true, reason: "pool_busy" };
  }
  async tick(now = new Date()): Promise<void> {
    if (this.closing || this.ticking) return;
    this.ticking = true;
    try {
      const sets = await this.library.list();
      for (const summary of sets) {
        if (this.closing) break;
        try {
          const set = await this.library.get(summary.name);
          const expires = summarize(set, now.getTime(), this.config.warnDays).authExpiresAt;
          if (
            expires &&
            Date.parse(expires) <= now.getTime() + this.config.warnDays * 86_400_000 &&
            set.health?.warnedExpiry !== expires
          ) {
            await this.deps.notify({
              event: "cookieset.expiring",
              severity: "warning",
              title: `Login expiring: ${set.name}`,
              message: `Authentication cookies expire at ${expires}.`,
              data: { cookieSet: set.name, expiresAt: expires },
            });
            await this.library.markExpiryWarned(set.name, expires);
          }
          if (!set.check || set.check.enabled === false || !inCheckWindow(this.config.window, now))
            continue;
          const dueAt = set.health?.lastCheckAt
            ? Date.parse(set.health.lastCheckAt) + (set.check.intervalHours ?? 24) * 3_600_000
            : 0;
          if (now.getTime() >= dueAt) await this.checkAuthorized(set.name, "system:cookie-health");
        } catch (error) {
          this.deps.warn(error);
        }
      }
    } finally {
      this.ticking = false;
    }
  }
}

export async function prepareCookieSession(
  library: CookieLibraryService,
  options: StartSessionOptions,
  profilesDir = browserProfilesDir(),
): Promise<void> {
  if (options._resuming || !options.cookieSets?.length) return;
  const profileName = options.browserProfile;
  let saved: BrowserFingerprintWithHeaders | undefined;
  if (profileName) {
    if (!BROWSER_PROFILE_NAME.test(profileName)) throw new Error("Invalid saved browser name");
    try {
      saved = JSON.parse(
        await readFile(path.join(profilesDir, profileName, PROFILE_FINGERPRINT_FILE), "utf8"),
      );
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT")
        throw error;
    }
  }
  const existingIdentity = !!saved?.fingerprint?.navigator;
  const resolved = await library.prepareSession(options.cookieSets, {
    ...options,
    browserProfile: existingIdentity ? profileName : undefined,
  });
  Object.assign(options, resolved, { browserProfile: profileName });
  if (existingIdentity) {
    // Explicit launch fields win; a saved browser wins over a cookie-set pin.
    options.fingerprint ??= saved;
    options.userAgent ??= saved!.fingerprint.navigator.userAgent;
    const screen = saved!.fingerprint.screen;
    if (screen?.width > 0 && screen?.height > 0)
      options.dimensions ??= { width: screen.width, height: screen.height };
  }
  if (resolved.locale && !options.userPreferences?.intl?.accept_languages) {
    options.userPreferences = {
      ...options.userPreferences,
      intl: { ...options.userPreferences?.intl, accept_languages: resolved.locale },
    };
  }
}

function sessionFingerprint(server: FastifyInstance, session: Session): CookieFingerprint {
  const options = server.sessionService.getLaunchOptions(session.id);
  return {
    fingerprint: session.cdpService.getFingerprintData() ?? undefined,
    userAgent: session.cdpService.getUserAgent(),
    dimensions: session.cdpService.getDimensions(),
    timezone: options?.timezone,
    locale: options?.userPreferences?.intl?.accept_languages,
  };
}

declare module "fastify" {
  interface FastifyInstance {
    cookieHealth: CookieHealthService;
  }
}

export async function installCookieHealth(server: FastifyInstance): Promise<void> {
  const library = server.cookieLibrary;
  library.audit = async (event, detail) => {
    await server.audit.log(event, detail);
    // The session ID lets the timeline attach load/capture/write-back entries.
    // Never publish cookie values, previous versions, or fingerprint headers.
    server.events.publish(event, { cookieSet: detail.subject }, detail.sessionId);
  };
  const checker = new CookieHealthService(
    library,
    {
      runJob: (kind, options, fn) => server.jobs.run(kind, options, fn),
      notify: (message) => server.notifier.send(message),
      warn: (err) => server.log.warn({ err }, "Cookie health check failed"),
    },
    {
      warnDays: Math.max(0, Number(process.env.COOKIE_EXPIRY_WARN_DAYS ?? 3)),
      window: process.env.COOKIE_CHECK_WINDOW ?? "",
      settleMs: 2000,
    },
  );
  server.decorate("cookieHealth", checker);
  const remove = server.sessionService.hooks.add({
    onStarting: async (options) => prepareCookieSession(library, options),
    onStarted: async (session) => {
      if (!session.cookieSets?.length) return;
      await library.recordUse(
        session.cookieSets,
        session.client ?? "anonymous",
        session.id,
        sessionFingerprint(server, session),
      );
    },
    onEnding: async (session) => {
      if (session.cookieSetWriteBack === false || !session.cookieSets?.length || session.isSelenium)
        return;
      const state = await session.cdpService.getBrowserState();
      state.cookies = await session.cdpService.getCookies();
      for (const name of new Set(session.cookieSets)) {
        try {
          await library.assertAccess(name, session.client ?? "anonymous");
          const result = await library.writeBack(name, state);
          if (result.updated) {
            await library.audit("cookieset.writeback", {
              client: session.client,
              subject: name,
              sessionId: session.id,
            });
            library.changed(name, "cookieset.writeback");
          }
        } catch (err) {
          server.log.warn({ err, name }, "Cookie set write-back failed");
        }
      }
    },
  });
  server.addHook("onReady", async () => checker.start());
  server.addHook("preClose", async () => checker.stop());
  server.addHook("onClose", async () => {
    checker.stop();
    remove();
  });
}
export default fp(installCookieHealth, { name: "cookie-health" });
