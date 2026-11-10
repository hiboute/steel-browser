import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { HandoffService } from "../handoff.service.js";
import { TimelineService } from "../timeline.service.js";
import { RecordingService } from "../recording.service.js";
import { schemas } from "../../modules/handoff/agent-features.schema.js";
import handoffRoutes from "../../modules/handoff/handoff.routes.js";
import timelineRoutes from "../../modules/timeline/timeline.routes.js";
import recordingRoutes from "../../modules/recording/recording.routes.js";
import { getBaseUrl } from "../../utils/url.js";

declare module "fastify" {
  interface FastifyInstance {
    handoffs: HandoffService;
    timeline: TimelineService;
    recordings: RecordingService;
  }
}

const agentFeaturesPlugin: FastifyPluginAsync = async (server) => {
  const log = (err: unknown) => server.log.error({ err }, "Agent feature operation failed");
  const publish = (type: string, data: unknown, sessionId?: string) =>
    server.events.publish(type, data, sessionId);
  const getSession = (id: string) => server.sessionService.getSession(id);
  const timeline = new TimelineService({ store: server.store, getSession, publish, log });
  const recordings = new RecordingService({ store: server.store, getSession, publish, log });
  const handoffs = new HandoffService({
    store: server.store,
    getSession,
    publish,
    log,
    viewerUrl: process.env.STEEL_VIEWER_URL || getBaseUrl(),
    notify: (handoff) =>
      server.notifier.send({
        event: "handoff.waiting",
        severity: "info",
        title: "Browser needs your help",
        message: handoff.reason,
        url: handoff.liveUrl,
        sessionId: handoff.sessionId,
        data: { handoffId: handoff.id, instructions: handoff.instructions },
      }),
    changed: (handoff) =>
      timeline.append(
        handoff.sessionId,
        {
          kind: "handoff",
          tool: `handoff.${handoff.status}`,
          status: handoff.status,
          args: { handoffId: handoff.id, reason: handoff.reason },
        },
        handoff.resolvedBy ?? handoff.requestedBy,
      ),
  });
  server.decorate("handoffs", handoffs);
  server.decorate("timeline", timeline);
  server.decorate("recordings", recordings);
  for (const schema of schemas) server.addSchema(schema);
  await Promise.all([handoffs.initialize(), recordings.initialize(), timeline.sweep()]);

  const unsubscribe = server.sessionService.hooks.add({
    onStarted: async (session) => {
      timeline.attach(session);
      await timeline.append(session.id, {
        kind: "lifecycle",
        tool: "session.started",
        status: "live",
      });
      if (session.recording) await recordings.start(session.id);
    },
    onResumed: async (session) => {
      timeline.attach(session);
      await timeline.append(session.id, {
        kind: "lifecycle",
        tool: "session.resumed",
        status: "live",
      });
      if (session.recording) await recordings.start(session.id);
    },
    onEnding: async (session, { reason, park }) => {
      timeline.detachSession(session.id);
      if (handoffs.isWaiting(session.id)) {
        const handoff = await handoffs.resolve(
          session.id,
          "cancelled",
          "session",
          `Session ${park ? "parked" : "ended"}: ${reason}`,
        );
        Object.assign(session, { handoff });
      }
      if (
        recordings
          .list()
          .some(
            (recording) => recording.sessionId === session.id && recording.status === "recording",
          )
      )
        await recordings.stop(session.id, park ? "parked" : reason);
      session.recording = false;
      await timeline.append(session.id, {
        kind: "lifecycle",
        tool: park ? "session.parked" : "session.ended",
        status: park ? "parked" : "released",
        args: { reason },
      });
    },
  });
  const unsubscribeEvents = server.events.subscribe((event) => {
    if (event.type.startsWith("cookieset.") && event.sessionId) {
      void timeline
        .append(event.sessionId, {
          kind: "cookieset",
          tool: event.type,
          status: "done",
          args: event.data,
        })
        .catch(log);
    }
  });
  const retention = setInterval(
    () => void Promise.all([timeline.sweep(), recordings.sweep()]).catch(log),
    3_600_000,
  );
  retention.unref();
  server.addHook("onClose", async () => {
    clearInterval(retention);
    unsubscribe();
    unsubscribeEvents();
    await handoffs.close();
    await recordings.close();
    await timeline.close();
  });
  await server.register(handoffRoutes, { prefix: "/v1" });
  await server.register(timelineRoutes, { prefix: "/v1" });
  await server.register(recordingRoutes, { prefix: "/v1" });
};

export default fp(agentFeaturesPlugin, { name: "agent-features", fastify: "5.x" });
