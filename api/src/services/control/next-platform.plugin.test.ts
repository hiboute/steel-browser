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
async function setup() {
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
    hooks: { add: () => () => {} },
  } as any);
  app.decorate("fileService", {} as any);
  app.decorate("browserPool", { setSchedulingPolicy: () => {} } as any);
  await app.register(fp(async () => {}, { name: "steel-platform" }));
  app.post("/v1/sessions/:id/test", async () => ({ mutated: true }));
  app.get("/v1/sessions/:id/test", async () => ({ read: true }));
  app.post("/v1/sessions", async () => ({ created: true }));
  app.get("/v1/search", async () => ({ results: [] }));
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
