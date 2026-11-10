import Fastify from "fastify";
import fp from "fastify-plugin";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import plugin from "./next-platform.plugin.js";
import { PlatformStore } from "../platform/store.js";
const roots: string[] = [];
const apps: ReturnType<typeof Fastify>[] = [];
const key = "test-verified-agent-token-at-least-24-characters";
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});
const added: any[] = [];
async function setup() {
  added.length = 0;
  vi.stubEnv("STEEL_AUTH_KEYS", JSON.stringify({ [key]: { id: "agent", role: "agent" } }));
  const app = Fastify();
  apps.push(app);
  const root = await mkdtemp(path.join(os.tmpdir(), "steel-auth-http-"));
  roots.push(root);
  app.decorate("store", new PlatformStore(root));
  app.decorate("events", { publish: () => {}, subscribe: () => () => {} } as any);
  app.decorate("sessionService", {
    listSessions: () => [],
    activeSession: { id: "idle" },
    hooks: {
      add: (hooks: any) => {
        added.push(hooks);
        return () => {};
      },
    },
  } as any);
  app.decorate("fileService", {} as any);
  app.decorate("browserPool", { setSchedulingPolicy: () => {} } as any);
  await app.register(fp(async () => {}, { name: "steel-platform" }));
  app.post("/v1/sessions/:id/test", async () => ({ mutated: true }));
  app.get("/v1/sessions/:id/test", async () => ({ read: true }));
  app.post("/v1/sessions", async () => ({ created: true }));
  app.get("/v1/search", async () => ({ results: [] }));
  app.get("/v1/sessions/debug", async () => ({ primary: true }));
  app.get("/v1/json/list", async () => ({ primary: true }));
  app.get("/v1/pool", async () => ({
    queue: [
      { sessionId: "s", client: "agent" },
      { sessionId: "other", client: "stranger" },
    ],
    slots: [
      { index: 0, sessionId: "other", sessionName: "private name", state: "live", primary: true },
    ],
  }));
  app.get("/v1/health", async () => ({ status: "ok" }));
  await app.register(plugin);
  await app.ready();
  await app.control.registerResource("s", "agent");
  await app.control.registerResource("other", "stranger");
  return app;
}
const auth = { authorization: `Bearer ${key}` };
describe("global route fencing", () => {
  it("protects routes registered before the plugin and rejects spoofed principals", async () => {
    const app = await setup();
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/sessions/s/test",
          headers: { "x-steel-client": "agent" },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/v1/sessions/other/test", headers: auth }))
        .statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: "POST", url: "/v1/sessions/s/test", headers: auth })).statusCode,
    ).toBe(409);
    const lease = await app.control.acquire(
      "s",
      { id: "agent", role: "agent", authenticated: true },
      { mode: "agent" },
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/sessions/s/test",
          headers: { ...auth, "x-steel-control": lease.token },
        })
      ).statusCode,
    ).toBe(200);
    await app.control.release(
      "s",
      { id: "agent", role: "agent", authenticated: true },
      lease.token,
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/sessions/s/test",
          headers: { ...auth, "x-steel-control": lease.token },
        })
      ).statusCode,
    ).toBe(409);
  });
  it("allows deterministic session creation and metadata search without primary control", async () => {
    const app = await setup();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/sessions",
          headers: auth,
          payload: { sessionId: "new-id" },
        })
      ).statusCode,
    ).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/search", headers: auth })).statusCode).toBe(
      200,
    );
    expect((await app.inject({ method: "GET", url: "/v1/health" })).json()).toEqual({
      status: "ok",
    });
  });
  it("supports fleet-only control IDs and keeps schema responses intact", async () => {
    const app = await setup();
    await app.control.registerResource("fleet-session", "agent");
    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions/fleet-session/control/acquire",
      headers: auth,
      payload: { mode: "agent" },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      lease: { sessionId: "fleet-session", ownerId: "agent", generation: 1 },
      token: expect.any(String),
    });
  });
});

it("binds legacy primary reads and hides other principals' queue and slot identity", async () => {
  const app = await setup();
  for (const url of [
    "/v1/sessions/debug",
    "/v1/json/list",
    "/v1/sessions/debug?sessionId=s",
    "/v1/json/list?sessionId=s",
  ])
    expect((await app.inject({ url, headers: auth })).statusCode).toBe(403);
  const pool = (await app.inject({ url: "/v1/pool", headers: auth })).json();
  expect(pool.queue).toEqual([{ sessionId: "s", client: "agent" }]);
  expect(pool.slots).toEqual([{ index: 0, sessionId: null, state: "live", primary: true }]);
});

it("moves the idle browser's ownership record when the idle browser is replaced", async () => {
  const app = await setup();
  expect(app.control.readers("idle")).toEqual(["local"]);
  (app.sessionService as any).activeSession = { id: "next-idle", status: "idle" };
  for (const hooks of added) await hooks.onEnded?.({ id: "s" });
  expect(app.control.readers("next-idle")).toEqual(["local"]);
  expect(app.control.readers("idle")).toEqual([]);
  // A live browser in the primary slot is not the idle browser.
  (app.sessionService as any).activeSession = { id: "busy", status: "live" };
  for (const hooks of added) await hooks.onParked?.({ id: "s" });
  expect(app.control.readers("busy")).toEqual([]);
  expect(app.control.readers("next-idle")).toEqual(["local"]);
});
