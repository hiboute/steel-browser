import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const testEnv = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock("../env.js", () => ({ env: testEnv }));
vi.mock("./cdp/cdp.service.js", () => ({ CDPService: class {} }));
vi.mock("./timezone-fetcher.service.js", () => ({
  TimezoneFetcher: class {
    getTimezone() {
      return Promise.resolve("Europe/Paris");
    }
  },
}));

import { BrowserPool } from "./browser-pool.service.js";
import { SessionService } from "./session.service.js";
import { PlatformStore } from "./platform/store.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  for (const key of Object.keys(testEnv)) delete testEnv[key];
  vi.useRealTimers();
});

const identity = {
  fingerprint: { navigator: { userAgent: "PinnedAgent", language: "fr-FR" } },
  headers: { "accept-language": "fr-FR" },
};
const cookies = [
  {
    name: "login",
    value: "auth-cookie",
    domain: "example.test",
    path: "/",
    secure: true,
    httpOnly: true,
    expires: -1,
  },
];

function makePage(url = "about:blank", active = true, scrollY = 0) {
  let currentUrl = url;
  return {
    url: () => currentUrl,
    title: vi.fn().mockResolvedValue(`Title ${url}`),
    evaluate: vi
      .fn()
      .mockImplementation(async (_fn, ...args) =>
        args.length
          ? undefined
          : { active, scrollX: 12, scrollY, storage: { draft: `draft-${url}` } },
      ),
    evaluateOnNewDocument: vi.fn().mockResolvedValue("injected"),
    goto: vi.fn().mockImplementation(async (next: string) => {
      currentUrl = next;
    }),
    bringToFront: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue(Buffer.from("jpeg-thumbnail")),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makeCdp(primary: boolean) {
  const cdp = {
    primary,
    pages: [makePage()],
    dimensions: { width: 1200, height: 800 },
    running: true,
    getUserAgent: () => "PinnedAgent",
    getDimensions: () => cdp.dimensions,
    getFingerprintData: () => identity,
    getCookies: vi.fn().mockResolvedValue(cookies),
    getAllPages: vi.fn(async () => cdp.pages),
    setDisconnectHandler: vi.fn(),
    startNewSession: vi.fn().mockImplementation(async (options) => {
      cdp.running = true;
      cdp.dimensions = options.dimensions;
      cdp.pages = [makePage()];
    }),
    endSession: vi.fn().mockImplementation(async () => {
      cdp.running = primary;
    }),
    shutdown: vi.fn().mockImplementation(async () => {
      cdp.running = false;
    }),
    launch: vi.fn().mockImplementation(async () => {
      cdp.running = true;
    }),
    isRunning: vi.fn(() => cdp.running),
    createPage: vi.fn(async () => {
      const page = makePage();
      cdp.pages.push(page);
      return page;
    }),
  };
  return cdp;
}

function makeService(size = 2) {
  const logger = { child: () => logger, info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const pool = new BrowserPool(size, 19222, logger as never, () => ({}), false);
  const browsers = pool.allSlots.map((slot) => {
    const browser = makeCdp(slot.index === 0);
    slot.cdpService = browser as never;
    return browser;
  });
  const service = new SessionService({
    browserPool: pool,
    seleniumService: { close: vi.fn().mockResolvedValue(undefined) } as never,
    fileService: {} as never,
    logger: logger as never,
  });
  cleanup.push(() => service.close());
  return { service, pool, browsers, logger };
}

async function setup(size = 2) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "steel-parking-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  Object.assign(testEnv, {
    STEEL_DATA_DIR: path.join(directory, "data"),
    STEEL_DATA_KEY: "park-test-key",
    BROWSER_PROFILES_DIR: path.join(directory, "saved"),
    CHROME_USER_DATA_DIR: path.join(directory, "chrome"),
    SESSION_REAPER_INTERVAL_MS: 60_000,
    SHUTDOWN_PARK_TIMEOUT_MS: 25,
  });
  const store = new PlatformStore(testEnv.STEEL_DATA_DIR as string, "park-test-key");
  return { ...makeService(size), directory, store };
}

async function exists(filename: string) {
  return stat(filename).then(
    () => true,
    () => false,
  );
}

async function parkedSession(fixture: Awaited<ReturnType<typeof setup>>, id = "parked") {
  const { service, browsers } = fixture;
  await service.startSession({
    sessionId: id,
    credentials: {},
    timezone: "Europe/Paris",
    dimensions: { width: 1200, height: 800 },
    name: "Draft",
  });
  const originalProfile = service.getLaunchOptions(id)!.userDataDir!;
  await writeFile(path.join(originalProfile, "retained-state"), `profile-${id}`);
  browsers[0].pages = [
    makePage("https://example.test/one", false, 120),
    makePage("https://example.test/two", true, 240),
  ];
  await service.parkSession(id);
  return { id, originalProfile, profile: service.getLaunchOptions(id)!.userDataDir! };
}

describe("durable session parking", () => {
  it("persists encrypted cookies, tabs, launch identity, and profile data across a restart", async () => {
    const fixture = await setup();
    const { service, browsers, store } = fixture;
    const { id, originalProfile, profile } = await parkedSession(fixture);
    expect(await exists(originalProfile)).toBe(false);
    expect(await readFile(path.join(profile, "retained-state"), "utf8")).toBe("profile-parked");
    const snapshot = await store.read<any>(`parked/${id}/meta.json`);
    expect(snapshot).toMatchObject({
      cookies,
      options: {
        fingerprint: identity,
        userAgent: "PinnedAgent",
        timezone: "Europe/Paris",
        dimensions: { width: 1200, height: 800 },
      },
      tabs: [
        {
          url: "https://example.test/one",
          scrollY: 120,
          storage: { draft: "draft-https://example.test/one" },
        },
        { url: "https://example.test/two", active: true, scrollY: 240 },
      ],
    });
    expect(await readFile(store.path(`parked/${id}/meta.json`), "utf8")).not.toContain(
      "auth-cookie",
    );
    await service.close();
    const restarted = makeService();
    await restarted.service.initialize();
    expect(restarted.service.getSession(id)).toMatchObject({
      status: "parked",
      slot: -1,
      tabs: snapshot.details.tabs,
    });
    const resumed = await restarted.service.resumeSession(id);
    expect(resumed).toMatchObject({
      id,
      status: "live",
      resumeCount: 1,
      createdAt: snapshot.details.createdAt,
    });
    expect(restarted.browsers[0].startNewSession).toHaveBeenLastCalledWith(
      expect.objectContaining({
        userDataDir: profile,
        fingerprint: identity,
        sessionContext: { cookies },
        userAgent: "PinnedAgent",
      }),
    );
    expect(restarted.browsers[0].pages.map((page) => page.url())).toEqual([
      "https://example.test/one",
      "https://example.test/two",
    ]);
    expect(restarted.browsers[0].pages[1].bringToFront).toHaveBeenCalledOnce();
    expect(restarted.browsers[0].pages[0].evaluateOnNewDocument).toHaveBeenCalledWith(
      expect.any(Function),
      "https://example.test",
      { draft: "draft-https://example.test/one" },
    );
    expect(browsers[0].endSession).toHaveBeenCalledOnce();
  });

  it("waits for a queued resume and tab restoration before releasing its profile", async () => {
    const fixture = await setup(1);
    const { service, pool, browsers } = fixture;
    const { id, profile } = await parkedSession(fixture);
    await service.startSession({ sessionId: "occupant", credentials: {}, timezone: "UTC" });
    const gate = Promise.withResolvers<void>();
    const restoringPage = makePage();
    restoringPage.goto.mockImplementation(async () => gate.promise);
    browsers[0].startNewSession.mockImplementationOnce(async () => {
      browsers[0].pages = [restoringPage];
      browsers[0].running = true;
    });
    const resuming = service.resumeSession(id, { queueTimeout: 5000 });
    await vi.waitFor(() => expect(pool.queuedCount).toBe(1));
    let released = false;
    const ending = service.endSession(id).then((details) => {
      released = true;
      return details;
    });
    expect(await readFile(path.join(profile, "retained-state"), "utf8")).toBe("profile-parked");
    await service.endSession("occupant");
    await vi.waitFor(() => expect(restoringPage.goto).toHaveBeenCalled());
    expect(released).toBe(false);
    expect(await exists(profile)).toBe(true);
    gate.resolve();
    await resuming;
    expect(await ending).toMatchObject({ status: "released" });
    expect(await exists(profile)).toBe(false);
    expect(pool.primary.state).toBe("free");
  });

  it("keeps the parked snapshot and profile when a client aborts during tab restoration", async () => {
    const fixture = await setup(1);
    const { service, browsers, store, pool } = fixture;
    const { id, profile } = await parkedSession(fixture);
    const gate = Promise.withResolvers<void>();
    const restoringPage = makePage();
    restoringPage.goto.mockImplementation(async () => gate.promise);
    browsers[0].startNewSession.mockImplementationOnce(async () => {
      browsers[0].pages = [restoringPage];
      browsers[0].running = true;
    });
    const abort = new AbortController();
    const resuming = service.resumeSession(id, { signal: abort.signal });
    const rejected = expect(resuming).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(restoringPage.goto).toHaveBeenCalled());
    abort.abort();
    gate.resolve();
    await rejected;
    expect(service.getSession(id)).toMatchObject({ status: "parked", resumeCount: 0 });
    expect(await exists(profile)).toBe(true);
    expect(await store.read(`parked/${id}/meta.json`)).toBeDefined();
    expect(pool.primary.state).toBe("free");
    expect((await service.resumeSession(id)).resumeCount).toBe(1);
  });

  it("relocates persist:true profiles so the next session cannot modify a parked browser", async () => {
    const fixture = await setup(2);
    const { service, directory, browsers } = fixture;
    const reusedPath = path.join(directory, "persistent-launch-path");
    await service.startSession({
      sessionId: "first",
      credentials: {},
      persist: true,
      userDataDir: reusedPath,
      timezone: "UTC",
    });
    await writeFile(path.join(reusedPath, "retained-state"), "first-browser");
    browsers[0].pages = [makePage("https://example.test/first")];
    await service.parkSession("first");
    const parkedPath = service.getLaunchOptions("first")!.userDataDir!;
    expect(parkedPath).not.toBe(reusedPath);
    await service.startSession({
      sessionId: "second",
      credentials: {},
      persist: true,
      userDataDir: reusedPath,
      timezone: "UTC",
    });
    await writeFile(path.join(reusedPath, "retained-state"), "second-browser");
    await service.resumeSession("first");
    expect(await readFile(path.join(parkedPath, "retained-state"), "utf8")).toBe("first-browser");
    expect(service.getSession("first")!.slot).not.toBe(service.getSession("second")!.slot);
    expect(browsers[1].startNewSession).toHaveBeenCalledWith(
      expect.objectContaining({ userDataDir: parkedPath }),
    );
  });

  it("retains the recoverable profile after a failed resume launch", async () => {
    const fixture = await setup(1);
    const { service, browsers, store, pool } = fixture;
    const { id, profile } = await parkedSession(fixture);
    browsers[0].startNewSession.mockRejectedValueOnce(new Error("Chrome launch failed"));
    await expect(service.resumeSession(id)).rejects.toThrow("Chrome launch failed");
    expect(service.isParked(id)).toBe(true);
    expect(await readFile(path.join(profile, "retained-state"), "utf8")).toBe("profile-parked");
    expect(await store.read(`parked/${id}/meta.json`)).toBeDefined();
    expect(pool.primary.state).toBe("free");
    expect(await service.resumeSession(id)).toMatchObject({ status: "live", resumeCount: 1 });
  });

  it("quarantines a failed resume whose Chrome cleanup also fails without deleting its parked data", async () => {
    const fixture = await setup(1);
    const { service, browsers, store, pool } = fixture;
    const { id, profile } = await parkedSession(fixture);
    browsers[0].startNewSession.mockRejectedValueOnce(new Error("launch failed"));
    browsers[0].shutdown.mockRejectedValue(new Error("Chrome still running"));
    await expect(service.resumeSession(id)).rejects.toThrow("launch failed");
    expect(service.getSession(id)).toMatchObject({ status: "parked" });
    expect(pool.primary.state).toBe("stopping");
    expect(pool.acquire("other")).toBeNull();
    expect(await readFile(path.join(profile, "retained-state"), "utf8")).toBe("profile-parked");
    expect(await store.read(`parked/${id}/meta.json`)).toBeDefined();
  });

  it("releases a saved browser for another session while its original session is parked", async () => {
    const { service, browsers } = await setup(1);
    await service.startSession({
      sessionId: "older",
      credentials: {},
      browserProfile: "account",
      timezone: "UTC",
    });
    await service.parkSession("older");
    expect(service.profileHolder("account")).toBeUndefined();
    const newer = await service.startSession({
      sessionId: "newer",
      credentials: {},
      browserProfile: "account",
      timezone: "UTC",
    });
    expect(newer.status).toBe("live");
    expect(service.getSession("older")?.status).toBe("parked");
    await expect(service.resumeSession("older")).rejects.toThrow("in use");
    const fresh = [{ ...cookies[0], value: "newer-login" }];
    browsers[0].getCookies.mockResolvedValue(fresh);
    await service.endSession("newer");
    await service.resumeSession("older");
    const restored = browsers[0].startNewSession.mock.calls.at(-1)![0].sessionContext;
    expect(restored?.cookies).not.toEqual(cookies);
  });

  it("cleans up a launch aborted while onStarted hooks are running", async () => {
    const { service, browsers, pool } = await setup(1);
    const gate = Promise.withResolvers<void>();
    const ending = vi.fn();
    const ended = vi.fn();
    const started = vi.fn(() => gate.promise);
    service.hooks.add({ onStarted: started, onEnding: ending, onEnded: ended });
    const abort = new AbortController();
    const creating = service.startSession({
      sessionId: "cancelled",
      credentials: {},
      signal: abort.signal,
      timezone: "UTC",
    });
    const rejected = expect(creating).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(started).toHaveBeenCalled());
    const profile = service.getLaunchOptions("cancelled")!.userDataDir!;
    abort.abort();
    gate.resolve();
    await rejected;
    expect(service.getSession("cancelled")).toBeUndefined();
    expect(await exists(profile)).toBe(false);
    expect(browsers[0].shutdown).toHaveBeenCalledOnce();
    expect(ending).toHaveBeenCalledOnce();
    expect(ended).toHaveBeenCalledOnce();
    expect(pool.primary.state).toBe("free");
  });

  it("returns to the parked snapshot when a resume is aborted in onResumed", async () => {
    const fixture = await setup(1);
    const { service, store, pool } = fixture;
    const { id, profile } = await parkedSession(fixture);
    const gate = Promise.withResolvers<void>();
    const resumed = vi.fn(() => gate.promise);
    service.hooks.add({ onResumed: resumed });
    const abort = new AbortController();
    const resuming = service.resumeSession(id, { signal: abort.signal });
    const rejected = expect(resuming).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(resumed).toHaveBeenCalled());
    abort.abort();
    gate.resolve();
    await rejected;
    expect(service.getSession(id)).toMatchObject({ status: "parked", slot: -1, resumeCount: 0 });
    expect(await exists(profile)).toBe(true);
    expect(await store.read(`parked/${id}/meta.json`)).toBeDefined();
    expect(pool.primary.state).toBe("free");
  });

  it("falls back to release when shutdown parking cannot capture browser state within its deadline", async () => {
    const { service, browsers, pool, logger } = await setup(1);
    await service.startSession({ sessionId: "stalled", credentials: {}, timezone: "UTC" });
    const profile = service.getLaunchOptions("stalled")!.userDataDir!;
    const gate = Promise.withResolvers<ReturnType<typeof makePage>[]>();
    browsers[0].getAllPages.mockReturnValue(gate.promise);
    await service.close();
    gate.resolve([]);
    expect(service.getSession("stalled")).toBeUndefined();
    expect(service.pastSessions.at(-1)).toMatchObject({
      status: "released",
      releaseReason: "shutdown",
    });
    expect(browsers[0].endSession).toHaveBeenCalledOnce();
    expect(pool.primary.state).toBe("free");
    expect(await exists(profile)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "Could not park session on shutdown",
    );
  }, 3000);
});

it("reuses restored Chrome tabs and closes surplus startup tabs rather than duplicating on every resume", async () => {
  const fixture = await setup();
  const { service, browsers } = fixture;
  const { id } = await parkedSession(fixture);
  const existing = [
    makePage("https://example.test/old-one"),
    makePage("https://example.test/old-two"),
    makePage("about:blank"),
  ];
  browsers[0].startNewSession.mockImplementationOnce(async () => {
    browsers[0].pages = existing;
    browsers[0].running = true;
  });
  await service.resumeSession(id);
  expect(browsers[0].createPage).not.toHaveBeenCalled();
  expect(existing[0].url()).toBe("https://example.test/one");
  expect(existing[1].url()).toBe("https://example.test/two");
  expect(existing[2].close).toHaveBeenCalledOnce();
});
