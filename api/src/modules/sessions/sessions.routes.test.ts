import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import customBodyParser from "../../plugins/custom-body-parser.js";
import { schemas } from "../../plugins/schemas.js";
import { PoolClosedError } from "../../services/browser-pool.service.js";
import { SessionPoolFullError } from "../../services/session.service.js";
import { IdentityError } from "../../services/identity/types.js";
import routes from "./sessions.routes.js";

const first = "00000000-0000-4000-8000-000000000001";
const second = "00000000-0000-4000-8000-000000000002";
const details = (id: string) => ({
  id,
  createdAt: new Date().toISOString(),
  status: "live",
  duration: 0,
  eventCount: 0,
  timeout: 0,
  creditsUsed: 0,
  proxyTxBytes: 0,
  proxyRxBytes: 0,
  websocketUrl: "ws://localhost/",
  debugUrl: "",
  debuggerUrl: "",
  sessionViewerUrl: "",
});
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function setup() {
  const app = Fastify();
  apps.push(app);
  const live = new Map([
    [first, details(first)],
    [second, details(second)],
  ]);
  const browser = {
    getBrowserState: vi.fn().mockResolvedValue({ cookies: [], localStorage: {} }),
    getAllPages: vi.fn(),
  };
  const pool = {
    maxSessions: 2,
    live: 2,
    free: 0,
    queued: 0,
    queue: [],
    slots: [
      { index: 0, primary: true, cdpPort: 9222, state: "live", sessionId: first },
      { index: 1, primary: false, cdpPort: 9224, state: "live", sessionId: second },
    ],
  };
  const service = {
    activeSession: { ...details(second), cdpService: browser },
    pastSessions: [],
    getSession: (id: string) => live.get(id),
    isEnding: () => false,
    findSocketSession: (id: string) =>
      live.has(id) ? { ...live.get(id), cdpService: browser } : undefined,
    listSessions: () => [...live.values()],
    getPoolStatus: () => pool,
    startSession: vi.fn().mockRejectedValue(new SessionPoolFullError(2)),
    endSession: vi.fn(async (id: string) => {
      const session = live.get(id)!;
      live.delete(id);
      return { ...session, status: "released" };
    }),
    endAllSessions: vi.fn(async () => {
      const sessions = [...live.values()];
      live.clear();
      return sessions;
    }),
  };
  app.decorate("sessionService", service as never);
  app.decorate("cdpService", browser as never);
  for (const schema of schemas) app.addSchema(schema);
  await app.register(customBodyParser);
  await app.register(routes, { prefix: "/v1" });
  await app.ready();
  return { app, service, browser, live, pool };
}

describe("session HTTP lifecycle", () => {
  it.each([
    ["identity_upgrade_required", 409],
    ["identity_override_conflict", 409],
    ["unsupported_platform_claim", 400],
  ])("preserves actionable %s launch errors", async (code, status) => {
    const { app, service } = await setup();
    const detail = { profile: "owned-identity", from: "Chrome/1", to: "Chrome/156" };
    service.startSession.mockRejectedValue(
      new IdentityError(code, "Review identity settings", status, detail),
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { identityProfile: "owned-identity" },
    });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({
      success: false,
      code,
      message: "Review identity settings",
      detail,
    });
  });

  it("parses the legacy release body and releases only its named session", async () => {
    const { app, service, live } = await setup();
    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions/release",
      payload: { sessionId: first },
    });
    expect(response.statusCode).toBe(200);
    expect(service.endSession).toHaveBeenCalledWith(first);
    expect(service.endAllSessions).not.toHaveBeenCalled();
    expect([...live.keys()]).toEqual([second]);
  });

  it("keeps empty release requests compatible and rejects malformed supplied ids", async () => {
    const { app, service } = await setup();
    const invalid = await app.inject({
      method: "POST",
      url: "/v1/sessions/release",
      payload: { sessionId: 123 },
    });
    expect(invalid.statusCode).toBe(400);
    expect(service.endAllSessions).not.toHaveBeenCalled();
    const empty = await app.inject({
      method: "POST",
      url: "/v1/sessions/release",
      headers: { "content-type": "application/json" },
      payload: "",
    });
    expect(empty.statusCode).toBe(200);
    expect(service.endAllSessions).toHaveBeenCalledOnce();
  });

  it("accepts a release request with no body or content type", async () => {
    const { app, service } = await setup();
    const response = await app.inject({ method: "POST", url: "/v1/sessions/release" });
    expect(response.statusCode).toBe(200);
    expect(service.endAllSessions).toHaveBeenCalledOnce();
  });

  it("returns actionable pool-full responses and validates queue timeouts", async () => {
    const { app, service } = await setup();
    const invalid = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { queueTimeout: -1 },
    });
    expect(invalid.statusCode).toBe(400);
    expect(service.startSession).not.toHaveBeenCalled();
    const full = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { queueTimeout: 50 },
    });
    expect(service.startSession.mock.calls[0][0]).toMatchObject({ queueTimeout: 50 });
    expect(full.statusCode).toBe(429);
    expect(full.headers["retry-after"]).toBe("1");
    expect(full.json()).toMatchObject({
      success: false,
      code: "pool_full",
      pool: { max: 2, live: 2, queued: 0 },
    });
  });

  it("returns 503 after the pool closes", async () => {
    const { app, service } = await setup();
    service.startSession.mockRejectedValue(new PoolClosedError());
    const response = await app.inject({ method: "POST", url: "/v1/sessions", payload: {} });
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe("shutting_down");
  });

  it("serializes slot states and queue status", async () => {
    const { app, pool } = await setup();
    const response = await app.inject("/v1/pool");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(pool);
  });

  it("never reads another browser for a missing session", async () => {
    const { app, browser } = await setup();
    for (const route of ["context", "live-details"]) {
      const response = await app.inject(`/v1/sessions/missing/${route}`);
      expect(response.statusCode).toBe(404);
    }
    expect(browser.getBrowserState).not.toHaveBeenCalled();
    expect(browser.getAllPages).not.toHaveBeenCalled();
    expect((await app.inject(`/v1/sessions/${first}/context`)).statusCode).toBe(200);
    expect(browser.getBrowserState).toHaveBeenCalledOnce();
  });

  it("cancels a queued launch when the HTTP client disconnects", async () => {
    const { app, service } = await setup();
    let cancelled = false;
    service.startSession.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              cancelled = true;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    );
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const abort = new AbortController();
    const response = fetch(`${address}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queueTimeout: 1000 }),
      signal: abort.signal,
    });
    const rejected = expect(response).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(service.startSession).toHaveBeenCalled());
    abort.abort();
    await rejected;
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });
});
