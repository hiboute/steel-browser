import { BrowserEventUnion } from "./types.js";
import { LogStorage } from "./storage/index.js";
import { EventEmitter } from "events";
import { BrowserEventType, EmitEvent } from "../../../types/enums.js";

export type Context = Record<string, any>;

/**
 * Logger interface compatible with both pino.Logger and FastifyBaseLogger.
 * This avoids type conflicts between different pino versions (v9 vs v10).
 */
export interface Logger {
  info(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface BrowserLogger {
  /** Permanently omit payloads for this browser after a vault fill. */
  setPrivateCapture?(): void;
  record(event: BrowserEventUnion): void;
  resetContext(): void;
  setContext(
    update: Partial<Context> | ((prev: Readonly<Context>) => Partial<Context> | Context),
  ): void;
  getContext(): Readonly<Context>;
  flush?(): Promise<void>;
  getStorage?(): LogStorage | null;
  on?(event: EmitEvent.Log, listener: (event: BrowserEventUnion, context: Context) => void): this;
  off?(event: EmitEvent.Log, listener: (event: BrowserEventUnion, context: Context) => void): this;
}

export interface CreateBrowserLoggerOptions {
  baseLogger: Logger;
  initialContext?: Context;
  storage?: LogStorage;
  enableConsoleLogging?: boolean;
}

export function createBrowserLogger(options: CreateBrowserLoggerOptions): BrowserLogger {
  let context: Context = options.initialContext ?? {};
  const storage = options.storage || null;
  const enableConsoleLogging = options.enableConsoleLogging ?? true;
  const eventEmitter = new EventEmitter();
  let privateCapture = false;

  const resetContext = () => {
    context = options.initialContext ?? {};
  };

  const setContext = (
    update: Partial<Context> | ((prev: Readonly<Context>) => Partial<Context> | Context),
  ) => {
    if (typeof update === "function") {
      const result = update(context);
      context = { ...context, ...result };
    } else {
      context = { ...context, ...update };
    }
  };

  const getContext = (): Readonly<Context> => context;

  const record = (event: BrowserEventUnion) => {
    // A vault-filled page can reflect credentials into console, network and CDP payloads.
    // Disable instrumentation entirely for this browser; structured vault audit remains available.
    if (privateCapture) return;
    const mergedEvent = { ...context, ...event };
    if (enableConsoleLogging) options.baseLogger.info(mergedEvent, event.type);
    if (storage)
      storage
        .write(event, context)
        .catch((err) => options.baseLogger.error({ err }, "Failed to write event to storage"));
    if (event.type !== BrowserEventType.Recording) eventEmitter.emit(EmitEvent.Log, event, context);
  };

  const flush = async () => {
    if (storage) {
      await storage.flush();
    }
  };

  const getStorage = () => storage;

  const on = (
    event: EmitEvent.Log,
    listener: (event: BrowserEventUnion, context: Context) => void,
  ) => {
    eventEmitter.on(event, listener);
    return logger;
  };

  const off = (
    event: EmitEvent.Log,
    listener: (event: BrowserEventUnion, context: Context) => void,
  ) => {
    eventEmitter.off(event, listener);
    return logger;
  };

  const logger: BrowserLogger = {
    setPrivateCapture: () => {
      privateCapture = true;
    },
    record,
    resetContext,
    setContext,
    getContext,
    flush,
    getStorage,
    on,
    off,
  };

  return logger;
}
