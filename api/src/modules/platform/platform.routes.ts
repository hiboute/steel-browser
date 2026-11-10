import type { FastifyInstance } from "fastify";

const tags = ["Platform"];
const jsonObject = { type: "object", additionalProperties: true } as const;

export default async function platformRoutes(server: FastifyInstance) {
  const streams = new Set<() => void>();
  server.addHook("preClose", async () => {
    for (const close of streams) close();
  });

  server.get<{ Querystring: { types?: string; sessionId?: string } }>(
    "/v1/events",
    {
      schema: {
        operationId: "subscribe_events",
        tags,
        summary: "Subscribe to lifecycle events over SSE",
        querystring: {
          type: "object",
          properties: {
            types: { type: "string", maxLength: 500 },
            sessionId: { type: "string", maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      const types = new Set((request.query.types ?? "").split(",").filter(Boolean));
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      reply.raw.write(": connected\n\n");
      const unsubscribe = server.events.subscribe((event) => {
        if (request.query.sessionId && request.query.sessionId !== event.sessionId) return;
        if (types.size && !types.has(event.type) && !types.has(event.type.split(".")[0] + ".*"))
          return;
        if (reply.raw.writableLength > 1024 * 1024) {
          close();
          return;
        }
        reply.raw.write(
          `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        );
      });
      const heartbeat = setInterval(() => {
        if (!reply.raw.destroyed) reply.raw.write(": heartbeat\n\n");
      }, 25_000);
      heartbeat.unref();
      const close = () => {
        clearInterval(heartbeat);
        unsubscribe();
        streams.delete(close);
        reply.raw.end();
      };
      streams.add(close);
      reply.raw.once("close", close);
    },
  );

  server.get(
    "/v1/notifications",
    {
      schema: {
        operationId: "get_notifications",
        tags,
        summary: "List the latest 200 notifications",
        response: { 200: { type: "array", items: jsonObject } },
      },
    },
    async () => server.notifier.list(),
  );

  server.get<{
    Querystring: { limit?: number; before?: string; event?: string; subject?: string };
  }>(
    "/v1/audit",
    {
      schema: {
        operationId: "get_audit",
        tags,
        summary: "Read retained audit events",
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 1000, default: 100 },
            before: { type: "string", format: "date-time" },
            event: { type: "string", maxLength: 128 },
            subject: { type: "string", maxLength: 256 },
          },
        },
        response: { 200: { type: "array", items: jsonObject } },
      },
    },
    async (request) => server.audit.list(request.query),
  );

  server.get(
    "/v1/egress",
    {
      schema: {
        operationId: "list_egress",
        tags,
        summary: "List egress profiles and cached connectivity health",
        response: {
          200: {
            type: "object",
            properties: {
              default: { type: "string" },
              profiles: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    label: { type: "string" },
                    type: { type: "string", enum: ["direct", "proxy", "nordvpn"] },
                    healthy: { type: ["boolean", "null"] },
                    publicIp: { type: ["string", "null"] },
                    country: { type: ["string", "null"] },
                    checkedAt: { type: ["string", "null"] },
                  },
                },
              },
            },
          },
        },
      },
    },
    async () => server.egress.list(),
  );

  server.get(
    "/metrics",
    { schema: { operationId: "get_metrics", tags, summary: "Prometheus metrics" } },
    async (_request, reply) => {
      const pool = server.sessionService.getPoolStatus();
      server.metrics.gauge("steel_sessions_live", pool.live);
      server.metrics.gauge("steel_pool_free", pool.free);
      server.metrics.gauge("steel_pool_queue_length", pool.queued);
      server.metrics.gauge("steel_background_running", server.jobs.running);
      const memory = server.memory.snapshot(
        server.browserPool.allSlots.flatMap((slot) => {
          const pid = slot.cdpService.getPid();
          return pid ? [pid] : [];
        }),
      );
      server.metrics.gauge("steel_memory_available_bytes", memory.availableBytes);
      server.metrics.gauge("steel_chrome_rss_bytes", memory.chromeRssBytes);
      server.metrics.gauge("steel_memory_pressure", Number(memory.pressure));
      server.metrics.clearGauge("steel_cookie_set_auth_expiry_timestamp_seconds");
      server.metrics.clearGauge("steel_cookie_set_check_success");
      for (const set of await server.cookieLibrary.list()) {
        server.metrics.gauge(
          "steel_cookie_set_auth_expiry_timestamp_seconds",
          set.authExpiresAt ? Date.parse(set.authExpiresAt) / 1000 : 0,
          { name: set.name },
        );
        server.metrics.gauge(
          "steel_cookie_set_check_success",
          Number(set.health.lastResult?.ok === true),
          { name: set.name },
        );
      }
      reply.type("text/plain; version=0.0.4; charset=utf-8");
      return server.metrics.render();
    },
  );
}
