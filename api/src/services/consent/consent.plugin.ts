import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import type { Session } from "../session.service.js";
import { ConsentService } from "./consent.service.js";

declare module "fastify" {
  interface FastifyInstance {
    consent: ConsentService;
  }
}

/**
 * Wires `autoConsent` sessions to the consent service: started and resumed
 * sessions are watched, what gets clicked lands in the session details
 * (`pageFilters`), the timeline and the event stream.
 */
const consentPlugin: FastifyPluginAsync = async (server) => {
  const consent = new ConsentService({
    getSession: (id) => server.sessionService.getSession(id),
    paused: (id) => {
      if (server.handoffs?.isWaiting(id)) return "handoff";
      // A person who took the browser over decides about its banners.
      if (server.control?.get(id)?.mode === "human") return "human_control";
      if (server.workflowService?.hasPendingReview(id)) return "review";
      return undefined;
    },
    log: (err) => server.log.debug({ err }, "Consent banner scan failed"),
    record: async (event) => {
      const session = server.sessionService.getSession(event.sessionId);
      const filters = session?.pageFilters;
      if (filters && event.dismissed) {
        filters.bannersDismissed += 1;
        filters.lastBanner = {
          at: new Date().toISOString(),
          manager: event.manager,
          action: event.action,
          label: event.label,
          url: event.url,
        };
      }
      server.log.info(
        {
          sessionId: event.sessionId,
          manager: event.manager,
          action: event.action,
          dismissed: event.dismissed,
        },
        "Consent banner button clicked",
      );
      server.events?.publish(
        event.dismissed ? "consent.dismissed" : "consent.clicked",
        { manager: event.manager, action: event.action, label: event.label, url: event.url },
        event.sessionId,
      );
      await server.timeline
        ?.append(event.sessionId, {
          kind: "consent",
          tool: `consent.${event.action}`,
          url: event.url,
          status: event.dismissed ? "done" : "unconfirmed",
          args: { manager: event.manager, label: event.label },
        })
        .catch((err) => server.log.debug({ err }, "Consent timeline entry failed"));
    },
  });
  server.decorate("consent", consent);
  const start = async (session: Session) => {
    const mode = session.pageFilters?.autoConsent;
    if (mode === "reject" || mode === "accept") await consent.attach(session, mode);
  };
  const unhook = server.sessionService.hooks.add({
    onStarted: start,
    onResumed: start,
    onEnding: (session) => consent.detach(session.id),
  });
  server.addHook("onClose", async () => {
    unhook();
    consent.close();
  });
};

export default fp(consentPlugin, { name: "consent", fastify: "5.x" });
