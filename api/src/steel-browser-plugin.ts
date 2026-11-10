import nextPlatformPlugin from "./services/control/next-platform.plugin.js";
import identityPlugin from "./services/identity/identity.plugin.js";
import fleetPlugin from "./services/fleet/fleet.plugin.js";
import dataPlugin from "./services/data/data.plugin.js";
import workflowsPlugin from "./services/workflows/workflows.plugin.js";
import workbenchPlugin from "./services/workbench/workbench.plugin.js";
import workspaceIndexPlugin from "./services/workspace-index.plugin.js";
import { isSensitiveSession } from "./services/data/privacy.js";
import { WorkflowError } from "./services/workflows/workflows.types.js";
import extrasPlugin from "./services/extras.plugin.js";
import platformPlugin from "./services/platform/platform.plugin.js";
import cookieHealthPlugin from "./services/cookie-health.service.js";
import agentFeaturesPlugin from "./services/handoff/agent-features.plugin.js";
import fastifyView from "@fastify/view";
import cookieLibraryPlugin from "./plugins/cookie-library.js";
import cookieLibraryRoutes from "./modules/cookie-library/cookie-library.routes.js";
import browserProfilesRoutes from "./modules/browser-profiles/browser-profiles.routes.js";
import vpnRoutes from "./modules/vpn/vpn.routes.js";
import { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import path, { dirname } from "node:path";
import { env } from "./env.js";
import browserInstancePlugin from "./plugins/browser.js";
import browserSessionPlugin from "./plugins/browser-session.js";
import browserWebSocket from "./plugins/browser-socket/browser-socket.js";
import customBodyParser from "./plugins/custom-body-parser.js";
import fileStoragePlugin from "./plugins/file-storage.js";
import requestLogger from "./plugins/request-logger.js";
import openAPIPlugin from "./plugins/schemas.js";
import seleniumPlugin from "./plugins/selenium.js";
import {
  actionsRoutes,
  cdpRoutes,
  filesRoutes,
  logsRoutes,
  seleniumRoutes,
  sessionsRoutes,
} from "./routes.js";
import { fileURLToPath } from "node:url";
import ejs from "ejs";
import type { CDPService } from "./services/cdp/cdp.service.js";
import type { CommandEngine } from "./services/commands/engine.js";
import type { BrowserLauncherOptions } from "./types/browser.js";
import { WebSocketHandler } from "./types/websocket.js";
import { WebSocketRegistryService } from "./services/websocket-registry.service.js";
import { SessionService } from "./services/session.service.js";
import { LogStorage } from "./services/cdp/instrumentation/storage/log-storage.interface.js";

// We need to redeclare any decorators from within the plugin that we want to expose
declare module "fastify" {
  interface FastifyInstance {
    steelBrowserConfig: SteelBrowserConfig;
    cdpService: CDPService;
    sessionService: SessionService;
    webSocketRegistry: WebSocketRegistryService;
    commandEngine: CommandEngine | null;
    registerCDPLaunchHook: (hook: (config: BrowserLauncherOptions) => Promise<void> | void) => void;
    registerCDPShutdownHook: (
      hook: (config: BrowserLauncherOptions | null) => Promise<void> | void,
    ) => void;
  }

  interface LogStorageInterface extends LogStorage {}
}

export interface SteelBrowserConfig {
  fileStorage?: {
    maxSizePerSession?: number;
  };
  customWsHandlers?: WebSocketHandler[];
  logging?: {
    enableStorage?: boolean;
    storagePath?: string;
    enableConsoleLogging?: boolean;
    enableLogsRoutes?: boolean;
  };
}

const steelBrowserPlugin: FastifyPluginAsync<SteelBrowserConfig> = async (fastify, opts) => {
  fastify.decorate("steelBrowserConfig", opts);
  // Plugins
  await fastify.register(fastifyView, {
    engine: {
      ejs,
    },
    root: path.join(dirname(fileURLToPath(import.meta.url)), "templates"),
  });
  await fastify.register(requestLogger);
  await fastify.register(openAPIPlugin);
  await fastify.register(fileStoragePlugin);
  await fastify.register(browserInstancePlugin);
  await fastify.register(seleniumPlugin);
  await fastify.register(browserWebSocket, {
    customHandlers: opts.customWsHandlers,
  });
  await fastify.register(customBodyParser);
  await fastify.register(browserSessionPlugin);
  await fastify.register(cookieLibraryPlugin);
  await fastify.register(platformPlugin);
  await fastify.register(nextPlatformPlugin);
  await fastify.register(agentFeaturesPlugin);
  await fastify.register(identityPlugin);
  await fastify.register(cookieHealthPlugin);
  await fastify.register(fleetPlugin);
  fastify.sessionService.setIdleExemption(
    (id) => fastify.handoffs.isWaiting(id) || fastify.sessionCommands.busy(id),
  );
  fastify.sessionService.setParkGuard((id) => fastify.handoffs.isWaiting(id));
  fastify.sessionService.setEgressResolver((name) => fastify.egress.resolve(name));
  fastify.browserPool.setAdmissionGuard(() => fastify.memory.hasCapacity());
  fastify.sessionService.setPoolDetails(() => ({
    memory: fastify.memory.snapshot(
      fastify.browserPool.allSlots.flatMap((s) =>
        s.cdpService.getPid() ? [s.cdpService.getPid()!] : [],
      ),
    ),
    background: { running: fastify.jobs.running, max: fastify.jobs.max },
    limits: {
      timeout: env.SESSION_TIMEOUT_MS,
      idleTimeout: env.SESSION_IDLE_TIMEOUT_MS,
      queueTimeout: env.SESSION_QUEUE_TIMEOUT_MS,
      queueMax: env.SESSION_QUEUE_MAX_MS,
      parkedMax: env.PARKED_MAX,
      parkedTtl: env.PARKED_TTL_MS,
    },
    slotStats: Object.fromEntries(
      fastify.browserPool.allSlots.map((s) => [
        s.index,
        {
          pages: s.cdpService.getPageCount(),
          pid: s.cdpService.getPid() ?? null,
          rssBytes: s.cdpService.getPid()
            ? fastify.memory.processTreeRss(s.cdpService.getPid()!)
            : 0,
        },
      ]),
    ),
  }));

  await fastify.register(extrasPlugin);
  await fastify.register(dataPlugin);
  await fastify.register(workflowsPlugin, {
    evidenceAllowed: (id) => !isSensitiveSession(id),
    isSensitiveSession,
    vaultFill: async (context, input) => {
      const id = context.run.sessionId;
      if (!id)
        throw new WorkflowError(
          "session_required",
          "A live browser is required for vault fill",
          409,
        );
      return fastify.dataVaultFill(id, context.actor, input, {
        signal: context.signal,
        assertControl: () => fastify.control.assert(id, context.actor, context.controlToken),
      });
    },
    captureFileEvidence: async (context, assertion) => {
      const id = context.run.sessionId;
      if (!id)
        throw new WorkflowError(
          "session_required",
          "File evidence requires its owned browser",
          409,
        );
      fastify.control.assert(id, context.actor, context.controlToken);
      const evidence = await fastify.artifactProcessing.captureEvidence(
        assertion.artifactId,
        context.actor,
        assertion.sha256,
        8 * 1024 * 1024,
      );
      context.signal.throwIfAborted();
      fastify.control.assert(id, context.actor, context.controlToken);
      return evidence;
    },
    verifyAttachment: async (context, attachment) => {
      const record = await fastify.artifactProcessing.verify(
        attachment.artifactId,
        context.actor,
        attachment.sha256,
      );
      if (record.sessionId !== context.run.sessionId)
        throw new WorkflowError(
          "attachment_session_mismatch",
          "The reviewed attachment must belong to this browser",
          409,
        );
    },
  });
  await fastify.register(workbenchPlugin);
  await fastify.register(workspaceIndexPlugin);

  // Routes
  const commands = await import("./modules/commands/commands.routes.js");
  fastify.decorate("commandEngine", {
    getter() {
      const session = fastify.sessionService.activeSession;
      return session.status === "live" && !session.isSelenium
        ? fastify.sessionCommands.get(session.id)
        : null;
    },
  });
  await fastify.register(actionsRoutes, { prefix: "/v1" });
  await fastify.register(sessionsRoutes, { prefix: "/v1" });
  await fastify.register(cdpRoutes, { prefix: "/v1" });
  await fastify.register(seleniumRoutes);
  await fastify.register(filesRoutes, { prefix: "/v1" });
  await fastify.register(cookieLibraryRoutes, { prefix: "/v1" });
  await fastify.register(browserProfilesRoutes, { prefix: "/v1" });
  await fastify.register(vpnRoutes, { prefix: "/v1" });
  if (commands) {
    await fastify.register(commands.default, { prefix: "/v1" });
  }

  const enableLogsRoutes = opts.logging?.enableLogsRoutes ?? true;
  if (enableLogsRoutes) {
    await fastify.register(logsRoutes, { prefix: "/v1/logs" });
  }
  // Recovery can execute procedure hooks only after every feature has loaded
  // its persisted state and installed privacy, review and indexing policies.
  fastify.addHook("onReady", async () => fastify.runs.startRecovered());
};

export default fp<SteelBrowserConfig>(steelBrowserPlugin, {
  name: "steel-browser",
  fastify: "5.x",
});
