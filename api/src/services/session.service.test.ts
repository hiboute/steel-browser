import { describe, expect, it, vi } from "vitest";

vi.mock("../env.js", () => ({ env: {} }));
vi.mock("./timezone-fetcher.service.js", () => ({
  TimezoneFetcher: class {},
}));

import { IProxyServer } from "../utils/proxy.js";
import { SessionService } from "./session.service.js";

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
  };
}

function createPool(size: number) {
  const slots = Array.from({ length: size }, (_, index) => ({
    index,
    cdpPort: 9222 + index,
    cdpService: createCdp(index === 0),
    sessionId: null as string | null,
  }));
  return {
    slots,
    acquire: vi.fn((id: string, opts: { primaryOnly?: boolean } = {}) => {
      const slot = (opts.primaryOnly ? slots.slice(0, 1) : slots).find((s) => !s.sessionId);
      if (!slot) return null;
      slot.sessionId = id;
      return slot;
    }),
    release: vi.fn((id: string) => {
      const slot = slots.find((s) => s.sessionId === id);
      if (slot) slot.sessionId = null;
    }),
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
}

/** Puts a live session on slot `index` without launching a browser. */
function addLiveSession(
  service: SessionService,
  pool: ReturnType<typeof createPool>,
  id: string,
  proxy?: IProxyServer,
) {
  const slot = pool.acquire(id)!;
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
  const service = new SessionService({
    browserPool: pool as never,
    seleniumService: { close: vi.fn() } as never,
    fileService: {} as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
  });

  const proxy = withProxy ? createProxyServer() : undefined;
  const slot = addLiveSession(service, pool, "s1", proxy);

  return { service, pool, cdpService: slot.cdpService, proxy };
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
