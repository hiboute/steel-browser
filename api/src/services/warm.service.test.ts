import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WarmService, warmSessionId } from "./warm.service.js";
import { PlatformStore } from "./platform/store.js";

vi.mock("../utils/scrape/safeGoTo.js", () => ({ safeGoto: vi.fn().mockResolvedValue({}) }));
const directories: string[] = [];
const services: WarmService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "steel-warm-test-"));
  directories.push(root);
  const store = new PlatformStore(root);
  const live = new Map<string, any>();
  const pool = { queued: 0, free: 3 };
  const sessions = {
    maxSessions: 3,
    isClosing: false,
    getSession: (id) => live.get(id),
    getPoolStatus: () => pool,
    startSession: vi.fn(async (options) => {
      live.set(options.sessionId, {
        ...options,
        id: options.sessionId,
        status: "live",
        cdpService: { getPrimaryPage: async () => ({}) },
      });
      pool.free--;
      return { id: options.sessionId };
    }),
    endSession: vi.fn(async (id) => {
      live.delete(id);
      pool.free++;
    }),
    resumeSession: vi.fn(async (id) => {
      live.get(id).status = "live";
      pool.free--;
      return live.get(id);
    }),
  };
  const service = new WarmService(sessions as never, store, {
    error: vi.fn(),
    warn: vi.fn(),
  } as never);
  services.push(service);
  return { service, sessions, pool, live, store };
}

describe("warm sessions", () => {
  it("uses stable ids and keeps a slot available for user sessions", async () => {
    const { service, sessions, pool } = await setup();
    const first = await service.put("mail", { enabled: true }, "mcp:owner@example.com");
    await service.put("calendar", { enabled: true });
    expect(first.sessionId).toBe(warmSessionId("mail"));
    expect(sessions.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        client: "mcp:owner@example.com",
        keepAlive: true,
        timeout: 0,
        labels: { warm: "mail" },
      }),
    );
    expect(pool.free).toBe(1);
    await expect(service.put("third", { enabled: true })).rejects.toMatchObject({
      code: "warm_limit",
    });
  });
  it("waits behind queued users and resumes a persisted parked session", async () => {
    const { service, sessions, pool, live } = await setup();
    pool.queued = 1;
    await service.put("mail", { enabled: true });
    expect(sessions.startSession).not.toHaveBeenCalled();
    live.set(warmSessionId("mail"), { id: warmSessionId("mail"), status: "parked" });
    pool.queued = 0;
    await service.tick();
    expect(sessions.resumeSession).toHaveBeenCalledWith(warmSessionId("mail"), { queueTimeout: 0 });
  });
  it("loads saved settings and stops restarting during shutdown", async () => {
    const { service, sessions, store } = await setup();
    await store.write("warm.json", [
      {
        name: "mail",
        sessionId: warmSessionId("mail"),
        enabled: true,
        status: "live",
        lastStartedAt: "2020-01-01T00:00:00Z",
      },
    ]);
    await service.initialize();
    await service.tick();
    expect(sessions.startSession).toHaveBeenCalledOnce();
    sessions.isClosing = true;
    await sessions.endSession(warmSessionId("mail"));
    await service.tick();
    expect(sessions.startSession).toHaveBeenCalledOnce();
  });
});
