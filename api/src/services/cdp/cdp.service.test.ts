import { describe, expect, it, vi } from "vitest";
import { CDPService } from "./cdp.service.js";

type BrowserVersionHost = {
  browserInstance: { version: () => Promise<string> } | null;
  logger: { warn: (message: string) => void };
};

const getBrowserVersion = (host: BrowserVersionHost): Promise<string> =>
  CDPService.prototype.getBrowserVersion.call(host as unknown as CDPService);

const logger = { warn: vi.fn() };

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
