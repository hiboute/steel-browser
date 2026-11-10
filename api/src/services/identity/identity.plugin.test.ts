import Fastify from "fastify";
import fp from "fastify-plugin";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import plugin from "./identity.plugin.js";
import { PlatformStore } from "../platform/store.js";

let app: ReturnType<typeof Fastify>, dir: string;
const authorizeSession = vi.fn();
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "steel-identity-http-"));
  app = Fastify();
  await app.register(
    fp(
      async (server) => {
        server.decorate("store", new PlatformStore(dir));
        server.decorate("events", { publish: vi.fn(), subscribe: () => () => {} });
        server.decorate("sessionService", {
          getSession: () => undefined,
          getLaunchOptions: () => undefined,
          hooks: { add: () => () => {} },
        });
        server.decorate("jobs", { run: async () => undefined });
        server.decorate("egress", {
          checkResolved: async () => ({ healthy: true, publicIp: "203.0.113.1", country: "FR" }),
          resolve: async () => ({}),
        });
        server.decorate("access", {
          actor: (r: any) => ({
            authenticated: r.headers.authorization === "Bearer operator",
            role: "operator",
            id: "operator",
          }),
          authorizeSession,
        });
      },
      { name: "steel-platform" },
    ),
  );
  await app.register(
    fp(
      async (server) => {
        server.decorate("handoffs", {});
      },
      { name: "agent-features" },
    ),
  );
  await app.register(plugin);
  await app.ready();
  app.identity.browserVersion = async () => "Chromium 149.0.1.2";
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});
const headers = { authorization: "Bearer operator" };
it("requires authenticated operator rather than attribution headers for profile edits", async () => {
  const response = await app.inject({
    method: "PUT",
    url: "/v1/identity-profiles/private",
    headers: { "x-steel-client": "operator" },
    payload: { settings: { compatibilityMode: "native" } },
  });
  expect(response.statusCode).toBe(403);
  expect(await app.identity.listProfiles()).toEqual([]);
});
it("exposes profile revision, migration, site CRUD and validation through real Fastify routes", async () => {
  const created = await app.inject({
    method: "PUT",
    url: "/v1/identity-profiles/account",
    headers,
    payload: { settings: { compatibilityMode: "native" }, bindings: { browserProfile: "account" } },
  });
  expect(created.statusCode).toBe(200);
  expect(created.json()).toMatchObject({ schemaVersion: 2, revision: 1, hasFingerprint: false });
  const stale = await app.inject({
    method: "PUT",
    url: "/v1/identity-profiles/account",
    headers,
    payload: { settings: { compatibilityMode: "native" } },
  });
  expect(stale.statusCode).toBe(409);
  const migrated = await app.inject({
    method: "POST",
    url: "/v1/identity-profiles/account/migrate",
    headers,
    payload: { expectedRevision: 1, compatibilityMode: "compatible" },
  });
  expect(migrated.statusCode).toBe(200);
  expect(migrated.json().revision).toBe(2);
  const site = await app.inject({
    method: "PUT",
    url: "/v1/site-profiles/portal",
    headers,
    payload: {
      origin: "https://portal.test",
      identityProfile: "account",
      permissions: ["notifications"],
      interaction: { actionDelayMs: 100, frictionDetection: true },
    },
  });
  expect(site.statusCode).toBe(200);
  expect(
    (await app.inject({ method: "GET", url: "/v1/site-profiles", headers })).json().profiles,
  ).toHaveLength(1);
  const invalid = await app.inject({
    method: "PUT",
    url: "/v1/site-profiles/unsafe",
    headers,
    payload: { origin: "file:///etc/passwd" },
  });
  expect(invalid.statusCode).toBe(400);
  expect(
    (await app.inject({ method: "DELETE", url: "/v1/site-profiles/portal", headers })).json(),
  ).toEqual({ deleted: true });
});
it("bounds matrix sizes and identifies mobile capabilities without claiming hardware acceptance", async () => {
  const tooMany = await app.inject({
    method: "POST",
    url: "/v1/compatibility/matrix",
    headers,
    payload: { variants: Array.from({ length: 9 }, () => ({ compatibilityMode: "native" })) },
  });
  expect(tooMany.statusCode).toBe(400);
  const mobile = (await app.inject({ method: "GET", url: "/v1/mobile-profiles", headers })).json();
  expect(mobile.realDevice.validated).toBe(false);
  expect(mobile.profiles[0]).toMatchObject({
    runtime: "chromium-emulation",
    capabilities: { realDevice: false },
  });
});
it("does not expose raw IP or upstream in continuity preview and rejects traversal names", async () => {
  const preview = await app.inject({
    method: "POST",
    url: "/v1/identity/continuity/preview",
    headers,
    payload: { identityProfile: "account", egress: "home" },
  });
  expect(preview.statusCode).toBe(200);
  expect(preview.body).not.toContain("203.0.113.1");
  expect(preview.json().status).toBe("new");
  expect(
    (
      await app.inject({
        method: "PUT",
        url: "/v1/identity-profiles/a%2Fb",
        headers,
        payload: { settings: { compatibilityMode: "native" } },
      })
    ).statusCode,
  ).toBe(400);
});
it("serves the stealth scorecard history and lets only an operator start a run", async () => {
  const list = await app.inject({ method: "GET", url: "/v1/identity/scorecards" });
  expect(list.statusCode).toBe(200);
  expect(list.json()).toEqual({ configured: "legacy", defaultMode: "legacy", scorecards: [] });
  expect((await app.inject({ method: "POST", url: "/v1/identity/scorecard/run" })).statusCode).toBe(
    403,
  );
  const run = await app.inject({ method: "POST", url: "/v1/identity/scorecard/run", headers });
  expect(run.statusCode).toBe(200);
  // No free browser: every mode is skipped and nothing is stored as evidence.
  expect(run.json().modes.map((m: any) => m.status)).toEqual(["skipped", "skipped", "skipped"]);
  expect(
    (await app.inject({ method: "GET", url: "/v1/identity/scorecards" })).json().scorecards,
  ).toEqual([]);
  expect(typeof (app as any).sessionService.fingerprintRefresher).toBe("function");
});
