import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { describe, it, expect, vi } from "vitest";
import { CDPService } from "../cdp/cdp.service.js";
import { PlatformStore } from "../platform/store.js";
import { IdentityService } from "./identity.service.js";
import { IdentityCollector, observe } from "./collector.js";
import { FrictionService } from "./friction.service.js";
import { HandoffService } from "../handoff.service.js";
import type { Session, StartSessionOptions } from "../session.service.js";

const chrome =
  process.env.CHROME_EXECUTABLE_PATH ||
  (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
const logger = { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() };

describe.skipIf(!chrome)("owned real Chromium identity fixtures", () => {
  it("runs native and compatible desktop/mobile matrices without opaque patching, compares headers and gates regressions", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "steel-identity-browser-"));
    let browser: Browser | undefined;
    let service: IdentityService | undefined;
    try {
      browser = await puppeteer.launch({
        executablePath: chrome,
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
        defaultViewport: null,
      });
      const version = await browser.version();
      const store = new PlatformStore(dir);
      let current: Session;
      let options: StartSessionOptions = { credentials: undefined };
      service = new IdentityService({
        store,
        getSession: () => current,
        getOptions: () => options,
        browserVersion: async () => version,
      });
      let baseline: string | undefined;
      let breakPermission = false;
      for (const [mode, mobileProfile] of [
        ["native", undefined],
        ["compatible", undefined],
        ["compatible", "android-compact"],
        ["compatible", "android-landscape"],
      ] as const) {
        options = {
          credentials: undefined,
          compatibilityMode: mode,
          mobileProfile,
          headless: true,
        };
        await service.prepare(options);
        const host = Object.assign(Object.create(CDPService.prototype), {
          launchConfig: {
            compatibilityMode: mode,
            skipFingerprintInjection: options.skipFingerprintInjection,
          },
          fingerprintData: options.fingerprint ?? null,
          compatibilityFallbacks: new Set(),
          emulationSessions: new Map(),
          logger,
          currentSessionConfig: { userAgent: options.userAgent },
        });
        const configure = async (page: Page) => {
          await host.applyDeviceMetricsOverride(page);
          if (mode !== "native") await host.injectFingerprintSafely(page, options.fingerprint);
        };
        const wrapped = {
          newPage: async () => {
            const p = await browser!.newPage();
            await configure(p);
            if (breakPermission)
              await p.evaluateOnNewDocument(() => {
                navigator.permissions.query = async () => {
                  throw new Error("Injected candidate regression");
                };
              });
            return p;
          },
        } as Browser;
        const active = await wrapped.newPage();
        await active.goto(`${await service.collector.start()}fixture`);
        current = {
          id: `session-${mode}-${mobileProfile ?? "desktop"}`,
          status: "live",
          userAgent: options.userAgent,
          cdpService: {
            getBrowserInstance: () => wrapped,
            getBrowserVersion: () => browser!.version(),
            getAllPages: async () => [active],
            getCompatibilityState: () => host.getCompatibilityState(),
            getFingerprintData: () => options.fingerprint,
          },
        } as unknown as Session;
        const report = await service.inspect(current.id);
        expect(report.observed.status).toBe("measured");
        expect(report.collector.status).toBe("measured");
        expect(
          report.issues.filter((i) => i.severity === "error"),
          JSON.stringify({
            mode,
            mobileProfile,
            requested: report.requested,
            observed: report.observed,
          }),
        ).toEqual([]);
        expect(JSON.stringify(report)).not.toContain("secret-cookie");
        const lab = await service.lab(current.id, baseline);
        expect(lab.checks.filter((c) => c.status === "fail")).toEqual([]);
        expect(lab.passed).toBe(true);
        expect(lab.regressions).toEqual([]);
        baseline = lab.id;
        if (mobileProfile) {
          const measured = await observe(active);
          expect(measured.touch.maxTouchPoints).toBeGreaterThan(0);
          expect(measured.clientHints?.mobile).toBe(true);
          expect(measured.screen.width).toBe(options.dimensions?.width);
          expect(measured.screen.orientation).toBe(
            mobileProfile.includes("landscape") ? "landscape-primary" : "portrait-primary",
          );
        }
        const semantic = await active.evaluate(() => ({
          console: Function.prototype.toString.call(console.debug).includes("[native code]"),
          worker: Function.prototype.toString.call(Worker).includes("[native code]"),
          reflection: Function.prototype.toString
            .call(Object.getOwnPropertyNames)
            .includes("[native code]"),
        }));
        expect(semantic).toEqual({ console: true, worker: true, reflection: true });
        await active.close();
      }
      // A candidate fixture failure must be visible as a regression against a previously passing baseline.
      breakPermission = true;
      const regression = await service.lab(current!.id, baseline);
      expect(regression.passed).toBe(false);
      expect(regression.regressions).toContain("permissions-query");
      expect((await service.labs()).length).toBe(5);
    } finally {
      await service?.close();
      await browser?.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("detects labeled friction, redacts secrets, pauses once, and respects human completion across restart", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "steel-friction-browser-"));
    const browser = await puppeteer.launch({
      executablePath: chrome,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const collector = new IdentityCollector();
    const page = await collector.open(browser);
    const store = new PlatformStore(dir);
    const publish = vi.fn();
    const session = {
      id: "friction-owned",
      status: "live",
      isSelenium: false,
      cdpService: { getAllPages: async () => [page], getBrowserInstance: () => browser },
    } as unknown as Session;
    const handoffs = new HandoffService({
      store,
      getSession: () => session,
      publish,
      log: vi.fn(),
      notify: async () => {},
      changed: async () => {},
      viewerUrl: "https://viewer.test",
    });
    let friction = new FrictionService({
      store,
      getSession: () => session,
      handoffs,
      publish,
      log: vi.fn(),
    });
    try {
      await handoffs.initialize();
      await friction.attach(session);
      await page.setContent(
        '<h1>Article about login safety</h1><p>Some sites say verify you are human.</p><input type="password" value="super-secret">',
      );
      expect((await friction.scan(session.id)).status).toBe("clear");
      await page.setContent(
        '<h1>Verification code</h1><input autocomplete="one-time-code" value="123456"><input type="password" value="super-secret">',
      );
      const found = await friction.scan(session.id);
      expect(found).toMatchObject({
        status: "waiting",
        finding: { kind: "two_factor" },
        automaticRetry: false,
      });
      expect(JSON.stringify(found)).not.toContain("123456");
      expect(JSON.stringify(found)).not.toContain("super-secret");
      expect(publish.mock.calls.filter((c) => c[0] === "friction.detected")).toHaveLength(1);
      await friction.scan(session.id);
      expect(publish.mock.calls.filter((c) => c[0] === "friction.detected")).toHaveLength(1);
      await handoffs.resolve(session.id, "done", "human");
      await friction.resolved(session.id);
      await friction.close();
      friction = new FrictionService({
        store,
        getSession: () => session,
        handoffs,
        publish,
        log: vi.fn(),
      });
      expect((await friction.scan(session.id)).status).toBe("resolved");
      expect(handoffs.isWaiting(session.id)).toBe(false);
      await page.setContent("<h1>Welcome</h1>");
      expect((await friction.scan(session.id)).status).toBe("clear");
      await page.setContent("<h1>Verify you are human</h1><button>Continue</button>");
      expect((await friction.scan(session.id)).finding?.kind).toBe("captcha");
      await handoffs.resolve(session.id, "expired", "timeout");
      await friction.resolved(session.id, "expired");
      expect((await friction.scan(session.id)).status).toBe("paused");
      expect(handoffs.isWaiting(session.id)).toBe(false);
    } finally {
      await friction.close();
      await handoffs.close();
      await collector.close();
      await browser.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 25_000);
});
