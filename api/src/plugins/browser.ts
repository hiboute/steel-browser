import { FastifyPluginAsync } from "fastify";
import { CDPService } from "../services/cdp/cdp.service.js";
import fp from "fastify-plugin";
import { BrowserLauncherOptions } from "../types/index.js";
import {
  DuckDBStorage,
  InMemoryStorage,
  LogStorage,
} from "../services/cdp/instrumentation/storage/index.js";
import path from "path";
import os from "os";
import { env } from "../env.js";
import { BrowserPool } from "../services/browser-pool.service.js";
import { ShutdownReason } from "../services/cdp/plugins/core/base-plugin.js";

declare module "fastify" {
  interface FastifyInstance {
    browserPool: BrowserPool;
    cdpService: CDPService;
    registerCDPLaunchHook: (hook: (config: BrowserLauncherOptions) => Promise<void> | void) => void;
    registerCDPShutdownHook: (
      hook: (config: BrowserLauncherOptions | null) => Promise<void> | void,
    ) => void;
  }
}

const browserInstancePlugin: FastifyPluginAsync = async (fastify, _options) => {
  const loggingConfig = fastify.steelBrowserConfig?.logging || {};
  const enableStorage = loggingConfig.enableStorage ?? env.LOG_STORAGE_ENABLED ?? false;
  const enableConsoleLogging = loggingConfig.enableConsoleLogging ?? true;

  const storagePathFor = (index: number) => {
    const base =
      loggingConfig.storagePath ||
      env.LOG_STORAGE_PATH ||
      path.join(os.tmpdir(), "steel-browser-logs", "logs.duckdb");
    // DuckDB holds an exclusive lock on its file, so each slot gets its own.
    return index === 0 ? base : base.replace(/(\.duckdb)?$/, `-slot${index}$1`);
  };

  const storages: LogStorage[] = [];
  for (let i = 0; i < Math.max(1, env.MAX_SESSIONS); i++) {
    const storage: LogStorage = enableStorage
      ? new DuckDBStorage({
          dbPath: storagePathFor(i),
          maxThreads: 1,
          memoryLimit: "128MB",
          parquetCompression: "none",
          enableWriteBuffer: true,
          writeBufferSize: 200,
          writeBufferFlushInterval: 2000,
        })
      : new InMemoryStorage(1000);
    await storage.initialize();
    storages.push(storage);
  }
  fastify.log.info(
    enableStorage
      ? `Log storage initialized at ${storagePathFor(0)} (${storages.length} slot(s))`
      : `Using in-memory log storage (${storages.length} slot(s))`,
  );

  const browserPool = new BrowserPool(
    env.MAX_SESSIONS,
    env.CDP_PORT_BASE,
    fastify.log,
    (index) => storages[index],
    enableConsoleLogging,
    env.CDP_RESERVED_PORTS,
  );
  const cdpService = browserPool.primary.cdpService;

  fastify.decorate("browserPool", browserPool);
  fastify.decorate("cdpService", cdpService);
  fastify.decorate(
    "registerCDPLaunchHook",
    (hook: (config: BrowserLauncherOptions) => Promise<void> | void) => {
      for (const slot of browserPool.allSlots) slot.cdpService.registerLaunchHook(hook);
    },
  );
  fastify.decorate(
    "registerCDPShutdownHook",
    (hook: (config: BrowserLauncherOptions | null) => Promise<void> | void) => {
      for (const slot of browserPool.allSlots) slot.cdpService.registerShutdownHook(hook);
    },
  );

  fastify.addHook("onListen", async function () {
    this.log.info("Launching default browser...");
    await cdpService.launch();
  });

  fastify.addHook("onClose", async () => {
    for (const slot of browserPool.allSlots.slice(1)) {
      if (slot.cdpService.isRunning()) {
        await slot.cdpService.shutdown(ShutdownReason.SESSION_END).catch(() => undefined);
      }
    }
  });
};

export default fp(browserInstancePlugin, "5.x");
