import Fastify from "fastify";
import fp from "fastify-plugin";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import dataPlugin from "./data.plugin.js";
import { PlatformStore } from "../platform/store.js";
import { DataError } from "./common.js";

it("data HTTP routes enforce principals, validate input, and never expose another owner's snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "steel-data-routes-"));
  const server = Fastify();
  await server.register(
    fp(
      async (app) => {
        app.decorate("store", new PlatformStore(root, "test-key"));
        app.decorate("access", {
          actor: (request: any) => ({
            id: request.headers["test-user"] || "alice",
            role: "agent",
            authenticated: true,
          }),
          authorizeSession: () => {
            throw new DataError("forbidden", "Session access denied", 403);
          },
          assertRead: () => {},
        } as unknown as typeof app.access);
        app.decorate("sessionService", {
          getSession: () => undefined,
          listSessions: () => [],
          getPoolStatus: () => ({ queued: 0 }),
          hooks: { add: () => () => {} },
        } as never);
        app.decorate("fileService", {
          forSession: () => ({ getBaseFilesPath: () => root }),
        } as never);
        app.decorate("audit", { log: async () => {} } as never);
      },
      { name: "steel-platform" },
    ),
  );
  await server.register(
    fp(
      async (app) => {
        app.decorate("watcherService", { setPageDiffs: () => {} } as never);
      },
      { name: "steel-extras" },
    ),
  );
  await server.register(dataPlugin);
  try {
    const record = await server.dataRecords.create("snapshot", "alice", {
      text: "private tea price",
      blocks: [],
      options: {},
      url: "https://example.com",
      observedAt: new Date().toISOString(),
    });
    expect(
      (
        await server.inject({
          url: `/v1/page-snapshots/${record.id}`,
          headers: { "test-user": "bob" },
        })
      ).statusCode,
    ).toBe(404);
    expect((await server.inject({ url: `/v1/page-snapshots/${record.id}` })).json()).toMatchObject({
      text: "private tea price",
    });
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/v1/sessions/forbidden/vault/fill",
          payload: { reference: "secret", selector: "#password" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/v1/workspace/export",
          payload: { scopes: ["profiles"], passphrase: "separate export passphrase" },
        })
      ).statusCode,
    ).toBe(403);
    expect((await server.inject({ url: "/v1/workspace/scopes" })).statusCode).toBe(403);
    expect((await server.inject({ url: "/v1/search?q=test&limit=999" })).statusCode).toBe(400);
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/v1/page-diffs",
          payload: { before: "../unsafe", after: "x" },
        })
      ).statusCode,
    ).toBe(400);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
