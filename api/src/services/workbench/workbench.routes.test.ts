import { beforeEach, afterEach, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlatformStore } from "../platform/store.js";
import { WorkbenchService } from "./workbench.service.js";
import routes from "../../modules/workbench/workbench.routes.js";
import type { WorkbenchAdapters, WorkSource } from "./types.js";
let app: FastifyInstance, root: string, source: WorkSource;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "workbench-routes-"));
  app = Fastify();
  source = {
    kind: "run",
    id: "r1",
    sessionId: "s1",
    ownerId: "alice",
    status: "paused",
    title: "Paused task",
    updatedAt: new Date().toISOString(),
    revision: 1,
    actions: ["retry"],
  };
  const adapters: WorkbenchAdapters = {
    unavailable: () => ["receipts"],
    sources: async () => [source],
    authorize: async () => {},
    perform: async () => {
      source.status = "running";
      source.revision = 2;
      return { id: "r1" };
    },
    telemetry: async () => ({ session: { id: "s1", status: "live" }, unavailable: [] }),
    handoff: () => undefined,
    timeline: async () => [],
    sessionOrigin: async () => "https://example.com",
  };
  app.decorate("workbench", new WorkbenchService(new PlatformStore(root), adapters));
  app.decorate("access", {
    actor: (r: any) => ({
      id: r.headers["test-principal"] || "alice",
      role: "agent",
      authenticated: true,
    }),
  } as unknown as typeof app.access);
  await app.register(routes, { prefix: "/v1" });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});
it("compiles schemas, exposes unavailable sources, and refuses stale actions", async () => {
  const list = await app.inject({ url: "/v1/inbox" });
  expect(list.statusCode).toBe(200);
  expect(list.json().unavailable).toEqual(["receipts"]);
  const card = list.json().items[0];
  const wrong = await app.inject({
    method: "POST",
    url: "/v1/inbox/run%3Ar1/actions",
    payload: { expectedRevision: "old", action: "retry" },
  });
  expect(wrong.statusCode).toBe(409);
  const action = await app.inject({
    method: "POST",
    url: "/v1/inbox/run%3Ar1/actions",
    payload: { expectedRevision: card.revision, action: "retry" },
  });
  expect(action.statusCode).toBe(200);
  expect(action.json().result.id).toBe("r1");
});
it("keeps personal state caller scoped and validates decisions", async () => {
  const list = await app.inject({ url: "/v1/inbox", headers: { "test-principal": "bob" } });
  expect(list.json().items).toEqual([]);
  const invalid = await app.inject({
    method: "POST",
    url: "/v1/recovery-knowledge/x/accept",
    payload: { expectedVersion: 1, sessionId: "s1", accepted: false, idempotencyKey: "k" },
  });
  expect(invalid.statusCode).toBe(400);
  const malformed = await app.inject({
    method: "PATCH",
    url: "/v1/inbox/run%3Ar1",
    payload: { expectedRevision: "x" },
  });
  expect(malformed.statusCode).toBe(400);
});
