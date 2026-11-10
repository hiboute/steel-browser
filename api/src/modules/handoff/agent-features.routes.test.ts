import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import agentFeaturesPlugin from "../../services/handoff/agent-features.plugin.js";
import { PlatformStore } from "../../services/platform/store.js";
import { PlatformEvents } from "../../services/platform/events.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "steel-agent-routes-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const app = Fastify();
  const session = {
    id: "session-1",
    status: "live",
    isSelenium: false,
    recording: false,
    cdpService: { getInstrumentationLogger: () => new EventEmitter(), getAllPages: async () => [] },
  };
  const hooks: any[] = [];
  const service = {
    getSession: (id: string) => (id === session.id ? session : undefined),
    pastSessions: [],
    touch: vi.fn(),
    holdActivity: () => () => {},
    getLaunchOptions: () => ({}),
    hooks: {
      add: (hook: unknown) => {
        hooks.push(hook);
        return () => {};
      },
    },
  };
  app.decorate("sessionService", service as never);
  app.decorate("store", new PlatformStore(directory));
  app.decorate("events", new PlatformEvents());
  app.decorate("notifier", { send: vi.fn().mockResolvedValue({}) } as never);
  await app.register(agentFeaturesPlugin);
  await app.ready();
  cleanup.push(() => app.close());
  return { app, service, session, hooks };
}

describe("agent feature HTTP contracts", () => {
  it("registers request/response schemas and preserves handoff fields", async () => {
    const { app, service } = await setup();
    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions/session-1/handoff",
      headers: { "x-steel-client": "mcp:alice" },
      payload: { reason: "2FA", instructions: "Enter the code", notify: false },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      status: "waiting",
      requestedBy: "mcp:alice",
      reason: "2FA",
      instructions: "Enter the code",
      resolvedAt: null,
    });
    const listed = await app.inject("/v1/handoffs?status=waiting");
    expect(listed.json().handoffs).toHaveLength(1);
    const done = await app.inject({
      method: "POST",
      url: "/v1/sessions/session-1/handoff/done",
      payload: { note: "Finished" },
    });
    expect(done.json()).toMatchObject({ status: "done", note: "Finished" });
    const calls = service.touch.mock.calls.length;
    expect((await app.inject("/v1/sessions/session-1/handoff")).json().status).toBe("done");
    expect(service.touch).toHaveBeenCalledTimes(calls);
  });

  it("validates condition, long-poll and timeline inputs", async () => {
    const { app } = await setup();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/sessions/session-1/handoff",
          payload: { reason: "" },
        })
      ).statusCode,
    ).toBe(400);
    expect((await app.inject("/v1/sessions/session-1/handoff?wait=51")).statusCode).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/sessions/session-1/timeline",
          payload: { tool: "navigate", durationMs: -1 },
        })
      ).statusCode,
    ).toBe(400);
    expect((await app.inject("/v1/sessions/session-1/recording/frames/0")).statusCode).toBe(400);
  });

  it("retains timeline data on a released session and does not create data for unknown IDs", async () => {
    const { app, session, service } = await setup();
    const entry = await app.inject({
      method: "POST",
      url: "/v1/sessions/session-1/timeline",
      payload: { tool: "browser_type", args: { selector: "input[type=password]", text: "secret" } },
    });
    expect(entry.statusCode).toBe(200);
    expect(entry.json()).toMatchObject({
      seq: 1,
      kind: "action",
      screenshot: false,
      args: { text: "[redacted]" },
    });
    session.status = "released";
    const touches = service.touch.mock.calls.length;
    expect(
      (await app.inject("/v1/sessions/session-1/timeline?after=0&limit=1")).json().entries,
    ).toHaveLength(1);
    expect(service.touch).toHaveBeenCalledTimes(touches);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/sessions/missing/timeline",
          payload: { tool: "x" },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("runs lifecycle hooks while a released session has already left the live map", async () => {
    const { app, session, hooks } = await setup();
    await hooks[0].onStarted(session);
    await app.handoffs.create(session.id, { reason: "Sign in", notify: false }, "client");
    session.status = "released";
    await hooks[0].onEnding(session, { reason: "timeout", park: false });
    expect(app.handoffs.get(session.id)).toMatchObject({ status: "cancelled" });
    expect((await app.timeline.read(session.id)).map((entry) => entry.tool)).toEqual([
      "session.started",
      "handoff.waiting",
      "handoff.cancelled",
      "session.ended",
    ]);
  });
});
