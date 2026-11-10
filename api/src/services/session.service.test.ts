import { describe, expect, it, vi } from "vitest";

vi.mock("../env.js", () => ({ env: {} }));
vi.mock("./timezone-fetcher.service.js", () => ({
  TimezoneFetcher: class {
    getTimezone() {
      return Promise.resolve("UTC");
    }
  },
}));

import { IProxyServer } from "../utils/proxy.js";
import { SessionService, redactProxyUrl } from "./session.service.js";

/**
 * A proxy whose byte counters settle when it closes, mirroring proxy-chain: a
 * connection is credited on `connectionClosed`, and a long-lived tunnel stays
 * open until the browser goes away.
 */
function createProxyServer() {
  const proxy: IProxyServer & { close: ReturnType<typeof vi.fn> } = {
    url: "http://127.0.0.1:0",
    upstreamProxyUrl: "",
    txBytes: 1_000,
    rxBytes: 2_000,
    listen: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockImplementation(async () => {
      Object.assign(proxy, { txBytes: 3_000, rxBytes: 400_000 });
    }),
  };
  return proxy;
}

function createCdp(primary: boolean) {
  return {
    primary,
    getUserAgent: () => "test-agent",
    getDimensions: () => ({ width: 1920, height: 1080 }),
    endSession: vi.fn().mockResolvedValue(undefined),
    setDisconnectHandler: vi.fn(),
    startNewSession: vi.fn().mockResolvedValue({}),
    shutdown: vi.fn().mockResolvedValue(undefined),
    launch: vi.fn().mockResolvedValue({}),
    isRunning: vi.fn().mockReturnValue(true),
  };
}

function createPool(size: number) {
  const slots = Array.from({ length: size }, (_, index) => ({
    index,
    cdpPort: 9222 + index,
    cdpService: createCdp(index === 0),
    sessionId: null as string | null,
    state: "free" as "free" | "starting" | "live" | "stopping",
  }));
  const pool = {
    slots,
    acquire: vi.fn((id: string, opts: { primaryOnly?: boolean } = {}) => {
      const slot = (opts.primaryOnly ? slots.slice(0, 1) : slots).find((s) => s.state === "free");
      if (!slot) return null;
      slot.sessionId = id;
      slot.state = "starting";
      return slot;
    }),
    release: vi.fn((id: string) => {
      const slot = slots.find((s) => s.sessionId === id);
      if (slot) {
        slot.sessionId = null;
        slot.state = "free";
      }
    }),
    acquireWhenAvailable: vi.fn(
      async (
        id: string,
        opts: { primaryOnly?: boolean } = {},
      ): Promise<(typeof slots)[number] | null> => pool.acquire(id, opts),
    ),
    markLive(id: string) {
      const slot = slots.find((s) => s.sessionId === id);
      if (slot) slot.state = "live";
    },
    markStopping(id: string) {
      const slot = slots.find((s) => s.sessionId === id);
      if (slot) slot.state = "stopping";
    },
    idleReady(index: number) {
      slots[index].state = "free";
    },
    close: vi.fn(),
    queuedCount: 0,
    queue: [],
    get primary() {
      return slots[0];
    },
    get allSlots() {
      return slots;
    },
    get maxSessions() {
      return slots.length;
    },
  };
  return pool;
}

/** Puts a live session on slot `index` without launching a browser. */
function addLiveSession(
  service: SessionService,
  pool: ReturnType<typeof createPool>,
  id: string,
  proxy?: IProxyServer,
) {
  const slot = pool.acquire(id)!;
  pool.markLive(id);
  const session = {
    id,
    createdAt: new Date().toISOString(),
    status: "live",
    proxyTxBytes: 0,
    proxyRxBytes: 0,
    isSelenium: false,
    complete: () => {},
    completion: Promise.resolve(),
    proxyServer: proxy,
    cdpService: slot.cdpService,
    slot: slot.index,
  };
  (service as unknown as { sessions: Map<string, unknown> }).sessions.set(id, session);
  return slot;
}

function createService({ withProxy = false, size = 1 } = {}) {
  const pool = createPool(size);
  const seleniumService = { close: vi.fn().mockResolvedValue(undefined) };
  const service = new SessionService({
    browserPool: pool as never,
    seleniumService: seleniumService as never,
    fileService: {} as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
  });

  const proxy = withProxy ? createProxyServer() : undefined;
  const slot = addLiveSession(service, pool, "s1", proxy);

  return { service, pool, cdpService: slot.cdpService, proxy, seleniumService };
}

describe("SessionService.endSession proxy accounting", () => {
  it("reports the counters the proxy settles on close", async () => {
    const { service, proxy } = createService({ withProxy: true });

    const released = await service.endSession();

    expect(proxy!.close).toHaveBeenCalledTimes(1);
    expect(proxy!.close).toHaveBeenCalledWith(true);
    expect(released.proxyRxBytes).toBe(400_000);
    expect(released.proxyTxBytes).toBe(3_000);
  });

  it("closes the proxy only after the browser is torn down", async () => {
    const order: string[] = [];
    const { service, cdpService, proxy } = createService({ withProxy: true });
    cdpService.endSession.mockImplementation(async () => {
      order.push("cdp");
    });
    proxy!.close.mockImplementation(async () => {
      order.push("proxy");
    });

    await service.endSession();

    expect(order).toEqual(["cdp", "proxy"]);
  });

  it("leaves the counters at zero when the session had no proxy", async () => {
    const { service } = createService();

    const released = await service.endSession();

    expect(released.proxyRxBytes).toBe(0);
    expect(released.proxyTxBytes).toBe(0);
  });
});

describe("SessionService with several browser slots", () => {
  it("waits for Selenium to exit before restarting the primary browser", async () => {
    const { service, pool, cdpService, seleniumService } = createService();
    service.getSession("s1")!.isSelenium = true;
    const gate = Promise.withResolvers<void>();
    seleniumService.close.mockReturnValue(gate.promise);
    const ending = service.endSession("s1");
    expect(pool.acquire("new")).toBeNull();
    expect(cdpService.launch).not.toHaveBeenCalled();
    gate.resolve();
    await ending;
    expect(cdpService.launch).toHaveBeenCalledOnce();
    expect(pool.slots[0].state).toBe("free");
  });

  it("keeps a stuck Selenium slot unavailable even if CDP cleanup would succeed", async () => {
    const { service, pool, cdpService, seleniumService } = createService();
    service.getSession("s1")!.isSelenium = true;
    seleniumService.close.mockRejectedValue(new Error("still running"));
    await expect(service.endSession("s1")).rejects.toThrow("still running");
    expect(pool.slots[0].state).toBe("stopping");
    expect(cdpService.launch).not.toHaveBeenCalled();
    expect(pool.acquire("new")).toBeNull();
  });

  it("closes admission, cleans up an in-flight launch and releases existing sessions on shutdown", async () => {
    const { service, pool } = createService({ size: 2 });
    const gate = Promise.withResolvers<void>();
    pool.slots[1].cdpService.startNewSession.mockReturnValue(gate.promise);
    const creating = service.startSession({ sessionId: "shutdown-pending", credentials: {} });
    const rejected = expect(creating).rejects.toThrow("shutting down");
    await vi.waitFor(() => expect(pool.slots[1].cdpService.startNewSession).toHaveBeenCalled());
    const closed = service.close();
    expect(service.close()).toBe(closed);
    expect(pool.close).toHaveBeenCalledOnce();
    gate.resolve();
    await rejected;
    await closed;
    expect(service.listSessions()).toEqual([]);
    expect(pool.slots[1].cdpService.shutdown).toHaveBeenCalledOnce();
    expect(pool.slots[0].cdpService.endSession).toHaveBeenCalledOnce();
    expect(pool.slots.every((slot) => slot.state === "free")).toBe(true);
  });

  it("does not lend a slot while the previous browser is shutting down", async () => {
    const { service, pool, cdpService } = createService();
    const gate = Promise.withResolvers<void>();
    cdpService.endSession.mockReturnValue(gate.promise);
    const ending = service.endSession("s1");
    expect(pool.slots[0].state).toBe("stopping");
    expect(pool.acquire("new")).toBeNull();
    gate.resolve();
    await ending;
    expect(pool.acquire("new")?.sessionId).toBe("new");
  });

  it("joins concurrent releases instead of running teardown twice", async () => {
    const { service, cdpService } = createService();
    const gate = Promise.withResolvers<void>();
    cdpService.endSession.mockReturnValue(gate.promise);
    const one = service.endSession("s1");
    const two = service.endSession("s1");
    gate.resolve();
    expect(await one).toBe(await two);
    expect(cdpService.endSession).toHaveBeenCalledTimes(1);
  });

  it("quarantines a slot whose teardown and cleanup both fail", async () => {
    const { service, pool, cdpService } = createService();
    cdpService.endSession.mockRejectedValue(new Error("end failed"));
    cdpService.shutdown.mockRejectedValue(new Error("still running"));
    await expect(service.endSession("s1")).rejects.toThrow("end failed");
    expect(pool.acquire("new")).toBeNull();
    expect(pool.slots[0].state).toBe("stopping");
  });

  it("cleans up a failed end hook before making the slot available", async () => {
    const { service, pool, cdpService } = createService();
    cdpService.endSession.mockRejectedValue(new Error("hook failed"));
    const gate = Promise.withResolvers<void>();
    cdpService.shutdown.mockReturnValue(gate.promise);
    const ending = service.endSession("s1");
    const rejected = expect(ending).rejects.toThrow("hook failed");
    expect(pool.acquire("new")).toBeNull();
    gate.resolve();
    await rejected;
    expect(cdpService.launch).toHaveBeenCalledOnce();
    expect(pool.slots[0].state).toBe("free");
  });

  it("keeps cleanup running when closing the proxy fails", async () => {
    const { service, pool, proxy } = createService({ withProxy: true });
    proxy!.close.mockRejectedValue(new Error("proxy close failed"));
    await service.endSession("s1");
    expect(pool.slots[0].state).toBe("free");
    expect(service.pastSessions).toHaveLength(1);
  });

  it("keeps a pending launch out of the live set and rejects duplicate ids", async () => {
    const { service, pool } = createService({ size: 2 });
    const gate = Promise.withResolvers<void>();
    pool.slots[1].cdpService.startNewSession.mockReturnValue(gate.promise);
    const creating = service.startSession({ sessionId: "pending", credentials: {} });
    await vi.waitFor(() => expect(pool.slots[1].cdpService.startNewSession).toHaveBeenCalled());
    expect(service.getSession("pending")).toBeUndefined();
    await expect(service.startSession({ sessionId: "pending", credentials: {} })).rejects.toThrow(
      "already live or changing state",
    );
    gate.resolve();
    await creating;
    expect(pool.slots[1].state).toBe("live");
    await service.endSession("pending");
  });

  it("tears down a launch cancelled after it acquired a slot", async () => {
    const { service, pool } = createService({ size: 2 });
    const gate = Promise.withResolvers<void>();
    const abort = new AbortController();
    pool.slots[1].cdpService.startNewSession.mockReturnValue(gate.promise);
    const creating = service.startSession({
      sessionId: "cancelled",
      credentials: {},
      signal: abort.signal,
    });
    const rejected = expect(creating).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(pool.slots[1].cdpService.startNewSession).toHaveBeenCalled());
    abort.abort();
    gate.resolve();
    await rejected;
    expect(pool.slots[1].cdpService.shutdown).toHaveBeenCalledOnce();
    expect(pool.slots[1].state).toBe("free");
    expect(service.getSession("cancelled")).toBeUndefined();
  });
  it("releases only the named session and frees its slot", async () => {
    const { service, pool } = createService({ size: 3 });
    const second = addLiveSession(service, pool, "s2");

    expect(service.listSessions().map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(service.activeSession.id).toBe("s2");

    await service.endSession("s1");

    expect(service.listSessions().map((s) => s.id)).toEqual(["s2"]);
    expect(pool.slots[0].sessionId).toBeNull();
    expect(second.sessionId).toBe("s2");
    expect(pool.slots[0].cdpService.endSession).toHaveBeenCalledTimes(1);
    expect(second.cdpService.endSession).not.toHaveBeenCalled();
  });

  it("refuses a new session when every slot is taken", async () => {
    const { service } = createService({ size: 1 });

    await expect(service.startSession({ credentials: {} as never })).rejects.toThrow(
      /browser slot/,
    );
  });

  it("releases a session whose browser disconnects on its own", async () => {
    const { service, pool } = createService({ size: 2 });
    addLiveSession(service, pool, "s2");
    const handler = pool.slots[1].cdpService.setDisconnectHandler.mock.calls[0][0];

    await handler();

    expect(service.getSession("s2")).toBeUndefined();
    expect(service.pastSessions.map((s) => s.id)).toContain("s2");
  });

  it("falls back to the idle placeholder once nothing is live", async () => {
    const { service } = createService();

    await service.endSession("s1");

    expect(service.activeSession.status).toBe("idle");
    expect(service.listSessions()).toEqual([]);
  });
});

describe("public proxy labels", () => {
  it("does not expose proxy credentials in session details", () => {
    expect(redactProxyUrl("http://alice:secret@proxy.example:8080")).toBe(
      "http://redacted:redacted@proxy.example:8080/",
    );
    expect(redactProxyUrl("malformed secret")).toBe("configured");
    expect(redactProxyUrl()).toBe("");
  });
});

describe("session expiry", () => {
  it("touch extends idle expiry but never the hard lifetime", async () => {
    const { service } = createService();
    const session = service.getSession("s1")!;
    const start = Date.now() - 5000;
    Object.assign(session, {
      createdAt: new Date(start).toISOString(),
      lastActivityAt: new Date(start).toISOString(),
      timeout: 10_000,
      idleTimeout: 6000,
      onExpire: "release",
    });
    service.touch("s1", "test");
    expect(Date.parse(session.expiresAt!)).toBe(start + 10_000);
    await service.reapExpiredSessions();
    expect(service.getSession("s1")).toBe(session);
    session.createdAt = new Date(Date.now() - 10_001).toISOString();
    await service.reapExpiredSessions();
    expect(service.getSession("s1")).toBeUndefined();
    expect(service.pastSessions[0].releaseReason).toBe("timeout");
  });

  it("expires abandoned sessions but not keepAlive or held work", async () => {
    const { service, pool } = createService({ size: 3 });
    addLiveSession(service, pool, "s2");
    addLiveSession(service, pool, "s3");
    for (const s of service.listSessions())
      Object.assign(s, {
        timeout: 0,
        idleTimeout: 1,
        onExpire: "release",
        lastActivityAt: new Date(Date.now() - 1000).toISOString(),
      });
    service.getSession("s2")!.keepAlive = true;
    const release = service.holdActivity("s3");
    service.getSession("s3")!.lastActivityAt = new Date(Date.now() - 1000).toISOString();
    await service.reapExpiredSessions();
    expect(service.listSessions().map((s) => s.id)).toEqual(["s2", "s3"]);
    expect(service.pastSessions[0].releaseReason).toBe("idle");
    release();
    release();
    expect(Date.parse(service.getSession("s3")!.lastActivityAt!)).toBeGreaterThan(Date.now() - 100);
    await service.endAllSessions();
  });

  it("shares overlapping reaper passes and holds the slot until teardown finishes", async () => {
    const { service, pool, cdpService } = createService();
    Object.assign(service.getSession("s1")!, {
      timeout: 1,
      onExpire: "release",
      createdAt: new Date(Date.now() - 1000).toISOString(),
    });
    const gate = Promise.withResolvers<void>();
    cdpService.endSession.mockReturnValue(gate.promise);
    const one = service.reapExpiredSessions();
    const two = service.reapExpiredSessions();
    expect(one).toBe(two);
    expect(pool.acquire("new")).toBeNull();
    await vi.waitFor(() => expect(cdpService.endSession).toHaveBeenCalledOnce());
    gate.resolve();
    await one;
    expect(pool.acquire("new")?.sessionId).toBe("new");
  });

  it("honors explicit zero values instead of applying environment timeouts", async () => {
    const { service } = createService();
    await service.endSession("s1");
    const session = await service.startSession({
      sessionId: "no-expiry",
      credentials: {},
      timeout: 0,
      idleTimeout: 0,
      keepAlive: true,
    });
    expect(session).toMatchObject({ timeout: 0, idleTimeout: 0, keepAlive: true, expiresAt: null });
    await service.endSession(session.id);
  });
});

describe("checkpoint of a live session", () => {
  it("returns the copy and leaves the browser parked when no slot is free to resume it", async () => {
    const warn = vi.fn();
    const service = Object.assign(Object.create(SessionService.prototype), {
      checkpointLocks: new Map(),
      starts: new Map(),
      endings: new Map(),
      transitioning: new Set(),
      parked: new Map(),
      snapshots: new Map(),
      closing: false,
      logger: { warn },
      getSession: () => ({ id: "s", status: "live" }),
      parkGuard: () => false,
      parkLiveSession: vi.fn(async function (this: any) {
        this.parked.set("s", {});
        this.snapshots.set("s", { details: { id: "s" }, profile: "/tmp/p", options: {} });
      }),
      resumeSession: vi.fn().mockRejectedValue(new Error("No browser slot available")),
    }) as any;
    await expect(service.withCheckpoint("s", async () => "copied")).resolves.toBe("copied");
    expect(service.resumeSession).toHaveBeenCalledWith("s", { queueTimeout: 20_000 });
    expect(warn).toHaveBeenCalledOnce();
    expect(service.checkpointLocks.size).toBe(0);
  });
});
