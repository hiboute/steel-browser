import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { ExtractService } from "./extract.service.js";
import { ExtensionService } from "./extensions.service.js";
import { WarmService } from "./warm.service.js";
import { WatcherService } from "./watchers.service.js";
import extrasRoutes from "../modules/extras/extras.routes.js";

declare module "fastify" {
  interface FastifyInstance {
    extractService: ExtractService;
    extensionService: ExtensionService;
    warmService: WarmService;
    watcherService: WatcherService;
  }
}

const extrasPlugin: FastifyPluginAsync = async (server) => {
  const extract = new ExtractService(server.sessionService);
  const extensions = new ExtensionService(server.store.path("extensions"), server.sessionService);
  const warm = new WarmService(server.sessionService, server.store, server.log);
  const watchers = new WatcherService(
    server.store,
    server.jobs,
    extract,
    server.events,
    server.notifier,
    server.log,
    () => server.sessionService.isClosing,
  );
  server.decorate("extractService", extract);
  server.decorate("extensionService", extensions);
  server.decorate("warmService", warm);
  server.decorate("watcherService", watchers);
  await server.register(extrasRoutes, { prefix: "/v1" });
  server.addHook("onReady", async () => {
    await warm.initialize();
    await watchers.initialize();
  });
  server.addHook("preClose", async () => {
    await warm.close();
    await watchers.close();
  });
};

export default fp(extrasPlugin, { name: "steel-extras", dependencies: ["steel-platform"] });
