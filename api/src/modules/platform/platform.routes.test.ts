import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import platformRoutes from "./platform.routes.js";
import { PlatformEvents } from "../../services/platform/events.js";
import { Metrics } from "../../services/platform/metrics.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function setup() {
  const app = Fastify();
  apps.push(app);
  const events = new PlatformEvents();
  app.decorate("events", events);
  app.decorate("metrics", new Metrics());
  app.decorate("notifier", {
    list: async () => [{ id: "notification", message: "test" }],
  } as never);
  app.decorate("audit", {
    list: vi.fn(async (query) => [{ event: query.event ?? "test", subject: query.subject }]),
  } as never);
  app.decorate("jobs", { running: 1 } as never);
  app.decorate("cookieLibrary", {
    list: async () => [
      {
        name: "login",
        authExpiresAt: "2030-01-01T00:00:00Z",
        health: { lastResult: { ok: true } },
      },
    ],
  } as never);
  app.decorate("sessionService", {
    getPoolStatus: () => ({ live: 2, free: 1, queued: 3 }),
  } as never);
  app.decorate("browserPool", { allSlots: [{ cdpService: { getPid: () => 123 } }] } as never);
  app.decorate("memory", {
    snapshot: () => ({ availableBytes: 1024, chromeRssBytes: 100, pressure: false }),
  } as never);
  app.decorate("egress", {
    list: async () => ({
      default: "direct",
      profiles: [
        {
          name: "direct",
          label: "direct",
          type: "direct",
          healthy: true,
          publicIp: "203.0.113.1",
          country: "US",
          checkedAt: new Date().toISOString(),
          proxyUrl: "secret",
        },
      ],
    }),
  } as never);
  await app.register(platformRoutes);
  await app.ready();
  return { app, events };
}

describe("platform HTTP endpoints", () => {
  it("publishes Prometheus text, validates audit queries, and strips proxy fields", async () => {
    const { app } = await setup();
    const metrics = await app.inject("/metrics");
    expect(metrics.headers["content-type"]).toContain("text/plain");
    expect(metrics.body).toContain("steel_sessions_live 2");
    expect(metrics.body).toContain("steel_pool_queue_length 3");
    expect(metrics.body).toContain('steel_cookie_set_check_success{name="login"} 1');
    expect((await app.inject("/v1/audit?limit=1001")).statusCode).toBe(400);
    expect(
      (await app.inject("/v1/audit?event=cookieset.loaded&subject=mail")).json(),
    ).toMatchObject([{ event: "cookieset.loaded", subject: "mail" }]);
    expect((await app.inject("/v1/egress")).body).not.toContain("secret");
    expect((await app.inject("/v1/notifications")).json()).toEqual([
      { id: "notification", message: "test" },
    ]);
  });

  it("filters SSE events, cleans up disconnected clients, and closes idle streams on shutdown", async () => {
    const { app, events } = await setup();
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const response = await fetch(`${address}/v1/events?types=session.*&sessionId=mine`);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(": connected");
    events.publish("pool.queue", {}, "mine");
    events.publish("session.started", {}, "another");
    events.publish("session.parked", { status: "parked" }, "mine");
    const data = new TextDecoder().decode((await reader.read()).value);
    expect(data).toContain("event: session.parked");
    expect(data).not.toContain("another");
    const closed = app.close();
    expect((await reader.read()).done).toBe(true);
    await closed;
  });
});
