import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { CDPService } from "./cdp.service.js";
import { ShutdownReason } from "./plugins/core/base-plugin.js";

type BrowserVersionHost = {
  browserInstance: { version: () => Promise<string> } | null;
  logger: { warn: (message: string) => void };
};

const getBrowserVersion = (host: BrowserVersionHost): Promise<string> =>
  CDPService.prototype.getBrowserVersion.call(host as unknown as CDPService);

const logger = { warn: vi.fn() };

describe("CDPService graceful shutdown", () => {
  afterEach(() => vi.useRealTimers());

  const createHost = () => {
    const internalListener = vi.fn();
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn((_signal: NodeJS.Signals) => true),
    });
    const browser = Object.assign(new EventEmitter(), {
      process: () => child,
      close: vi.fn(async () => {
        expect(browser.listenerCount("targetdestroyed")).toBe(1);
        browser.emit("targetdestroyed");
        child.exitCode = 0;
        child.emit("exit", 0, null);
      }),
    });
    browser.on("targetdestroyed", internalListener);
    const host = Object.assign(Object.create(CDPService.prototype), new EventEmitter(), {
      browserInstance: browser as typeof browser | null,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      chromeSessionService: { invalidate: vi.fn() },
      pluginManager: { onBrowserClose: vi.fn(), onShutdown: vi.fn() },
      shutdownHook: vi.fn(),
      removeAllHandlers() {
        this.browserInstance?.removeAllListeners();
      },
    });
    return { host, child, browser, internalListener };
  };

  it("keeps browser listeners intact through close and removes them afterward", async () => {
    const { host, child, browser, internalListener } = createHost();

    await host.shutdown(ShutdownReason.SESSION_END);

    expect(browser.close).toHaveBeenCalledOnce();
    expect(internalListener).toHaveBeenCalledOnce();
    expect(browser.listenerCount("targetdestroyed")).toBe(0);
    expect(child.kill).not.toHaveBeenCalled();
    expect(host.browserInstance).toBeNull();
  });

  it("waits for confirmed process exit after graceful close rejects", async () => {
    const { host, child, browser } = createHost();
    browser.close.mockRejectedValueOnce(new Error("Target closed"));
    const stopping = host.shutdown(ShutdownReason.SESSION_END);
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith("SIGTERM"));

    expect(host.browserInstance).toBe(browser);
    expect(host.shutdownHook).not.toHaveBeenCalled();
    expect(browser.listenerCount("targetdestroyed")).toBe(1);
    child.signalCode = "SIGTERM";
    child.emit("exit", null, "SIGTERM");
    await stopping;

    expect(host.browserInstance).toBeNull();
    expect(host.shutdownHook).toHaveBeenCalledOnce();
    expect(child.listenerCount("exit")).toBe(0);
  });

  it("preserves the instance for quarantine when neither termination signal exits it", async () => {
    vi.useFakeTimers();
    const { host, child, browser } = createHost();
    browser.close.mockRejectedValueOnce(new Error("Target closed"));
    const stopping = host.shutdown(ShutdownReason.SESSION_END);
    const rejection = expect(stopping).rejects.toThrow("slot must remain unavailable");
    await vi.advanceTimersByTimeAsync(5000);
    await rejection;

    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(child.listenerCount("exit")).toBe(0);
    expect(host.browserInstance).toBe(browser);
    expect(browser.listenerCount("targetdestroyed")).toBe(1);
    expect(host.shutdownHook).not.toHaveBeenCalled();
    expect(host.shuttingDown).toBe(false);
  });

  it("shares concurrent shutdown work until graceful close finishes", async () => {
    const { host, child, browser } = createHost();
    let finishClose!: () => void;
    browser.close.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishClose = () => {
            child.exitCode = 0;
            child.emit("exit", 0, null);
            resolve();
          };
        }),
    );
    const first = host.shutdown(ShutdownReason.SESSION_END);
    const second = host.shutdown(ShutdownReason.SESSION_END);
    await vi.waitFor(() => expect(browser.close).toHaveBeenCalledOnce());
    finishClose();
    await Promise.all([first, second]);

    expect(host.pluginManager.onShutdown).toHaveBeenCalledOnce();
    expect(host.shutdownHook).toHaveBeenCalledOnce();
    expect(host.browserInstance).toBeNull();
  });
});

describe("CDPService.isRunning", () => {
  const running = (browserInstance: unknown) =>
    CDPService.prototype.isRunning.call({ browserInstance } as unknown as CDPService);
  it("is false before launch and after disconnection or process exit", () => {
    expect(running(null)).toBe(false);
    expect(
      running({ connected: false, process: () => ({ exitCode: null, signalCode: null }) }),
    ).toBe(false);
    expect(running({ connected: true, process: () => ({ exitCode: 0, signalCode: null }) })).toBe(
      false,
    );
    expect(
      running({ connected: true, process: () => ({ exitCode: null, signalCode: "SIGTERM" }) }),
    ).toBe(false);
    expect(running({ connected: true, process: () => null })).toBe(false);
  });
  it("is true only for a connected browser with a live owned process", () => {
    expect(
      running({ connected: true, process: () => ({ exitCode: null, signalCode: null }) }),
    ).toBe(true);
  });
});

describe("CDPService.getBrowserVersion", () => {
  it("returns the version string reported by the browser", async () => {
    const version = "Chrome/150.0.7871.124";

    await expect(
      getBrowserVersion({ browserInstance: { version: async () => version }, logger }),
    ).resolves.toBe(version);
  });

  it("returns an empty string when no browser is running", async () => {
    await expect(getBrowserVersion({ browserInstance: null, logger })).resolves.toBe("");
  });

  it("returns an empty string when the browser fails to report a version", async () => {
    await expect(
      getBrowserVersion({
        browserInstance: {
          version: async () => {
            throw new Error("Target closed");
          },
        },
        logger,
      }),
    ).resolves.toBe("");
  });
});
