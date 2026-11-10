import fp from "fastify-plugin";
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { IdentityService, type LabReport } from "./identity.service.js";
import { FrictionService } from "./friction.service.js";
import { IdentityError, Name, ProfileInput, SiteInput, Mode } from "./types.js";
import { mobileProfiles } from "./mobile.js";
import type { StartSessionOptions } from "../session.service.js";

declare module "fastify" {
  interface FastifyInstance {
    identity: IdentityService;
    friction: FrictionService;
  }
}
/** Public reports omit raw IPs, upstream credentials, page text and cookie/fingerprint header bundles. */
async function authorize(
  server: FastifyInstance,
  request: FastifyRequest,
  id?: string,
  write = false,
) {
  const access = (server as any).access;
  if (!access)
    throw new IdentityError(
      "access_unavailable",
      "Authenticated access service is required for identity features",
      503,
    );
  if (id) {
    await access.authorizeSession(request, id, write);
    return;
  }
  const actor = access.actor(request);
  if (!actor?.authenticated || actor.role !== "operator")
    throw new IdentityError("operator_required", "An authenticated operator is required", 403);
}
const plugin: FastifyPluginAsync = async (server) => {
  const getSession = (id: string) => {
    const s = server.sessionService.getSession(id);
    if (!s) throw new IdentityError("session_not_found", "Session not found", 404);
    return s;
  };
  const identity = new IdentityService({
    store: server.store,
    getSession,
    getOptions: (id) => server.sessionService.getLaunchOptions(id),
    egressProbe: (name, proxyUrl) => server.egress.checkResolved(name, proxyUrl),
    resolveEgress: (name) => server.egress.resolve(name),
    cookieEgress: async (names, client) => {
      const sets = await Promise.all(
        names.map((name) => server.cookieLibrary.assertAccess(name, client)),
      );
      return sets.find((set) => set.egress)?.egress;
    },
    publish: (type, data, id) => server.events.publish(type, data, id),
  });
  const friction = new FrictionService({
    store: server.store,
    getSession,
    handoffs: server.handoffs,
    publish: (type, data, id) => server.events.publish(type, data, id),
    log: (e) => server.log.warn({ err: e }, "Friction observer failed"),
  });
  server.decorate("identity", identity);
  server.decorate("friction", friction);
  const unhook = server.sessionService.hooks.add({
    onStarting: (options) => identity.prepare(options),
    onStarted: async (session) => {
      await identity.started(session);
      if (server.sessionService.getLaunchOptions(session.id)?.frictionDetection)
        await friction.attach(session);
    },
    onResumed: async (session) => {
      if (server.sessionService.getLaunchOptions(session.id)?.frictionDetection)
        await friction.attach(session);
    },
    onEnding: (session) => friction.detach(session.id),
  });
  const unsubscribe = server.events.subscribe((event) => {
    if (
      event.sessionId &&
      ["handoff.done", "handoff.cancelled", "handoff.declined", "handoff.expired"].includes(
        event.type,
      )
    )
      void friction
        .resolved(
          event.sessionId,
          event.type.slice(8) as "done" | "cancelled" | "declined" | "expired",
        )
        .catch((e) => server.log.warn({ err: e }, "Friction resolution failed"));
  });
  server.addHook("onClose", async () => {
    unhook();
    unsubscribe();
    await friction.close();
    await identity.close();
  });
  await server.register(
    async (routes) => {
      routes.setErrorHandler((error: any, _req, reply) => {
        if (error instanceof z.ZodError)
          return reply.code(400).send({
            code: "invalid_request",
            message: "Invalid identity input",
            fields: error.issues.map((i) => i.path.join(".")),
          });
        const status = error.statusCode ?? 500;
        if (status >= 500) server.log.warn({ err: error }, "Identity operation failed");
        return reply.code(status).send({
          code: error.code ?? "identity_operation_failed",
          message: status >= 500 ? "Identity operation failed" : error.message,
          ...(error instanceof IdentityError && error.detail ? { detail: error.detail } : {}),
        });
      });
      const route = (
        method: "GET" | "POST" | "PUT" | "DELETE",
        url: string,
        operationId: string,
        handler: (request: any) => Promise<unknown>,
        body?: z.ZodType,
      ) =>
        routes.route({
          method,
          url,
          schema: {
            tags: ["Identity and compatibility"],
            operationId,
            ...(body ? { body: z.toJSONSchema(body, { target: "draft-7" }) } : {}),
          },
          handler,
        });
      route("GET", "/sessions/:id/identity", "inspect_session_identity", async (r) => {
        await authorize(server, r, r.params.id);
        return identity.inspect(r.params.id);
      });
      route("GET", "/identity-profiles", "list_identity_profiles", async (r) => {
        await authorize(server, r);
        return { profiles: await identity.listProfiles() };
      });
      route("GET", "/identity-profiles/:name", "get_identity_profile", async (r) => {
        await authorize(server, r);
        return identity.summary(await identity.profile(Name.parse(r.params.name)));
      });
      route(
        "PUT",
        "/identity-profiles/:name",
        "save_identity_profile",
        async (r) => {
          await authorize(server, r);
          return identity.putProfile(r.params.name, r.body);
        },
        ProfileInput,
      );
      route("DELETE", "/identity-profiles/:name", "delete_identity_profile", async (r) => {
        await authorize(server, r);
        await identity.deleteProfile(Name.parse(r.params.name));
        return { deleted: true };
      });
      route(
        "POST",
        "/identity-profiles/:name/capture",
        "capture_identity_profile",
        async (r) => {
          await authorize(server, r);
          await authorize(server, r, r.body.sessionId);
          return identity.captureProfile(r.params.name, r.body.sessionId, r.body.expectedRevision);
        },
        z
          .object({
            sessionId: z.string().max(128),
            expectedRevision: z.number().int().positive().optional(),
          })
          .strict(),
      );
      route(
        "POST",
        "/identity-profiles/:name/migrate",
        "migrate_identity_profile",
        async (r) => {
          await authorize(server, r);
          return identity.migrate(
            Name.parse(r.params.name),
            r.body.expectedRevision,
            r.body.compatibilityMode,
          );
        },
        z
          .object({
            expectedRevision: z.number().int().positive(),
            compatibilityMode: Mode.optional(),
          })
          .strict(),
      );
      route(
        "POST",
        "/identity-profiles/:name/continuity/reset",
        "reset_identity_continuity",
        async (r) => {
          await authorize(server, r);
          await identity.resetContinuity(Name.parse(r.params.name));
          return { reset: true };
        },
      );
      route(
        "POST",
        "/identity/continuity/preview",
        "preview_identity_continuity",
        async (r) => {
          await authorize(server, r);
          return identity.previewContinuity({ ...r.body, credentials: undefined });
        },
        z
          .object({
            identityProfile: Name.optional(),
            browserProfile: Name.optional(),
            cookieSets: z.array(Name).max(20).optional(),
            egress: z.string().max(80).optional(),
          })
          .strict(),
      );
      route("GET", "/sessions/:id/continuity", "get_session_continuity", async (r) => {
        await authorize(server, r, r.params.id);
        return identity.sessionContinuity(r.params.id);
      });
      route(
        "POST",
        "/sessions/:id/continuity/confirm",
        "confirm_session_continuity",
        async (r) => {
          await authorize(server, r);
          await authorize(server, r, r.params.id);
          return identity.confirmContinuity(r.params.id, r.body.token);
        },
        z.object({ token: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
      );
      route("GET", "/site-profiles", "list_site_profiles", async (r) => {
        await authorize(server, r);
        return { profiles: await identity.listSites() };
      });
      route("GET", "/site-profiles/:name", "get_site_profile", async (r) => {
        await authorize(server, r);
        return identity.site(Name.parse(r.params.name));
      });
      route(
        "PUT",
        "/site-profiles/:name",
        "save_site_profile",
        async (r) => {
          await authorize(server, r);
          return identity.putSite(r.params.name, r.body);
        },
        SiteInput,
      );
      route("DELETE", "/site-profiles/:name", "delete_site_profile", async (r) => {
        await authorize(server, r);
        await identity.deleteSite(Name.parse(r.params.name));
        return { deleted: true };
      });
      route(
        "POST",
        "/site-profiles/:name/success",
        "record_site_success",
        async (r) => {
          await authorize(server, r);
          await authorize(server, r, r.body.sessionId);
          return identity.markSiteSuccessful(Name.parse(r.params.name), r.body.sessionId);
        },
        z.object({ sessionId: z.string().max(128) }).strict(),
      );
      route("GET", "/mobile-profiles", "list_mobile_profiles", async (r) => {
        await authorize(server, r);
        return {
          profiles: mobileProfiles,
          realDevice: {
            adapter: "registered-android-worker",
            validated: false,
            reason:
              "Physical-device acceptance is recorded separately by worker registration; emulation is not hardware",
            registration: "Use the authenticated worker pairing API for an Android-capable worker",
            requiredCapabilities: { engine: "android", device: { kind: "android" } },
          },
        };
      });
      route("GET", "/sessions/:id/friction", "get_session_friction", async (r) => {
        await authorize(server, r, r.params.id);
        return friction.get(r.params.id);
      });
      route("POST", "/sessions/:id/friction/scan", "scan_session_friction", async (r) => {
        await authorize(server, r, r.params.id, true);
        return friction.scan(r.params.id);
      });
      route(
        "POST",
        "/compatibility/runs",
        "run_compatibility_fixtures",
        async (r) => {
          await authorize(server, r, r.body.sessionId, true);
          const release = server.sessionService.holdActivity(r.body.sessionId);
          try {
            return await identity.lab(r.body.sessionId, r.body.baselineId);
          } finally {
            release();
          }
        },
        z
          .object({ sessionId: z.string().max(128), baselineId: z.string().uuid().optional() })
          .strict(),
      );
      route("GET", "/compatibility/runs", "list_compatibility_runs", async (r) => {
        await authorize(server, r);
        return { reports: await identity.labs() };
      });
      route("GET", "/compatibility/runs/:id", "get_compatibility_run", async (r) => {
        const report = await identity.labReport(r.params.id);
        await authorize(server, r, report.sessionId);
        return report;
      });
      route(
        "POST",
        "/compatibility/matrix",
        "run_compatibility_matrix",
        async (r) => {
          await authorize(server, r);
          const reports: LabReport[] = [];
          for (const variant of r.body.variants) {
            let id: string | undefined;
            try {
              const created = await server.sessionService.startSession({
                credentials: undefined,
                compatibilityMode: variant.compatibilityMode,
                mobileProfile: variant.mobileProfile,
                headless: variant.headless ?? true,
                timeout: 120_000,
                keepAlive: true,
                labels: { purpose: "owned-compatibility-fixtures" },
                client: (server as any).access.actor(r).id,
              } as StartSessionOptions);
              id = created.id;
              reports.push(await identity.lab(id, variant.baselineId));
            } finally {
              if (id) await server.sessionService.endSession(id);
            }
          }
          return { reports, passed: reports.every((r) => r.passed && r.regressions.length === 0) };
        },
        z
          .object({
            variants: z
              .array(
                z
                  .object({
                    compatibilityMode: Mode,
                    mobileProfile: Name.optional(),
                    headless: z.boolean().optional(),
                    baselineId: z.string().uuid().optional(),
                  })
                  .strict(),
              )
              .min(1)
              .max(8),
          })
          .strict(),
      );
    },
    { prefix: "/v1" },
  );
};
export default fp(plugin, {
  name: "steel-identity",
  dependencies: ["steel-platform", "agent-features"],
});
