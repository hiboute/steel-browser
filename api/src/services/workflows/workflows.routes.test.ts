import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import workflowPlugin from "./workflows.plugin.js";
import { PlatformStore } from "../platform/store.js";
import { PlatformEvents } from "../platform/events.js";
import type { WorkflowRun, WorkflowRuntime } from "./workflows.types.js";

let server: FastifyInstance;
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "steel-workflow-routes-"));
  server = Fastify();
  const runtime: WorkflowRuntime = {
    registerKind() {},
    beforeStep() {},
    pauseError: (r) => new Error(r),
    list: () => [],
    get: () => {
      throw new Error("Missing run");
    },
    resume: async () => ({}) as WorkflowRun,
    cancel: async () => ({}) as WorkflowRun,
    create: async (input, actor) => ({
      id: "run",
      sessionId: input.sessionId,
      ownerId: actor.id,
      status: "queued",
      revision: 1,
      cursor: 0,
      steps: input.steps,
      results: [],
      metadata: input.metadata,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  };
  await server.register(
    fp(
      async (instance) => {
        instance.decorate("store", new PlatformStore(root, "key"));
        instance.decorate("events", new PlatformEvents());
      },
      { name: "steel-platform" },
    ),
  );
  await server.register(workflowPlugin, {
    runtime,
    actor: (request) => ({
      id: String(request.headers["x-test-user"] ?? "alice"),
      role: request.headers["x-test-user"] === "operator" ? "operator" : "agent",
      authenticated: request.headers["x-test-auth"] !== "false",
    }),
  });
  await server.ready();
});
afterEach(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

describe("workflow HTTP contracts", () => {
  const definition = {
    name: "Read title",
    steps: [
      { id: "read", kind: "commands", input: { commands: [{ command: "get", what: "title" }] } },
    ],
  };
  it("creates, versions and starts a procedure with typed schemas", async () => {
    const created = await server.inject({
      method: "POST",
      url: "/v1/procedures",
      payload: definition,
    });
    expect(created.statusCode).toBe(200);
    const procedure = created.json();
    const updated = await server.inject({
      method: "PUT",
      url: `/v1/procedures/${procedure.id}`,
      payload: { ...definition, name: "v2", expectedVersion: 1 },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().version).toBe(2);
    expect((await server.inject(`/v1/procedures/${procedure.id}?version=1`)).json().name).toBe(
      "Read title",
    );
    const run = await server.inject({
      method: "POST",
      url: `/v1/procedures/${procedure.id}/run`,
      payload: { version: 1, idempotencyKey: "test", sessionId: "session" },
    });
    expect(run.statusCode).toBe(200);
    expect(run.json().metadata.productProcedureVersion).toBe(1);
    expect(
      (await server.inject(`/v1/procedures/${procedure.id}/versions`)).json().versions,
    ).toHaveLength(2);
  });
  it("returns structured auth, ownership and validation failures", async () => {
    expect(
      (
        await server.inject({
          method: "GET",
          url: "/v1/procedures",
          headers: { "x-test-auth": "false" },
        })
      ).statusCode,
    ).toBe(401);
    const p = (
      await server.inject({ method: "POST", url: "/v1/procedures", payload: definition })
    ).json();
    const denied = await server.inject({
      url: `/v1/procedures/${p.id}`,
      headers: { "x-test-user": "bob" },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe("workflow_forbidden");
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/v1/procedures",
          payload: { name: "Incomplete" },
        })
      ).statusCode,
    ).toBe(400);
    expect((await server.inject("/v1/procedures/missing")).statusCode).toBe(404);
  });
  it("does not expose webhook tokens in list responses and requires delivery credentials", async () => {
    const p = (
      await server.inject({ method: "POST", url: "/v1/procedures", payload: definition })
    ).json();
    const schedule = (
      await server.inject({
        method: "POST",
        url: "/v1/procedure-schedules",
        payload: { name: "Webhook", procedureId: p.id, version: 1, trigger: { kind: "webhook" } },
      })
    ).json();
    expect(schedule.webhookToken).toBeTruthy();
    const listing = await server.inject("/v1/procedure-schedules");
    expect(listing.body).not.toContain(schedule.webhookToken);
    expect(listing.body).not.toContain("webhookHash");
    expect(
      (await server.inject({ method: "POST", url: `/v1/procedure-triggers/${schedule.id}` }))
        .statusCode,
    ).toBe(401);
    const triggered = await server.inject({
      method: "POST",
      url: `/v1/procedure-triggers/${schedule.id}`,
      headers: { "x-steel-webhook-token": schedule.webhookToken, "idempotency-key": "event1" },
    });
    expect(triggered.statusCode).toBe(200);
    expect(triggered.json().state).toBe("started");
  });
});
