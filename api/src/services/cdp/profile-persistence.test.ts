import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getChromeExecutablePath } from "../../utils/browser.js";
import { CDPService } from "./cdp.service.js";
import { ShutdownReason } from "./plugins/core/base-plugin.js";

vi.mock("../timezone-fetcher.service.js", () => ({
  TimezoneFetcher: class {
    getTimezone() {
      return Promise.resolve("UTC");
    }
  },
}));
vi.mock("../../utils/extensions.js", () => ({ getExtensionPaths: vi.fn().mockResolvedValue([]) }));

const logger = {
  child: () => logger,
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  trace: vi.fn(),
};
let directory: string | undefined;
let server: http.Server | undefined;
let service: CDPService | undefined;

afterEach(async () => {
  await service?.shutdown(ShutdownReason.SESSION_END);
  service = undefined;
  if (server)
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
  server = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe.skipIf(!existsSync(getChromeExecutablePath()))("Chrome profile persistence", () => {
  it("flushes immediately-written localStorage on endSession without reinjection or a delay", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "steel-profile-persistence-"));
    server = http.createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end('<script>window.savedAtLoad = localStorage.getItem("kept");</script>');
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const downloadPath = path.join(directory, "downloads");
    await mkdir(downloadPath);
    const config = {
      options: {
        headless: true,
        args: ["--no-sandbox", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"],
      },
      userDataDir: path.join(directory, "profile"),
      downloadPath,
      timezone: Promise.resolve("UTC"),
      skipFingerprintInjection: true,
    };
    service = new CDPService(
      { primary: false, cdpPort: 0 },
      logger as unknown as FastifyBaseLogger,
      undefined,
      false,
    );
    await service.startNewSession(config);
    const page = (await service.getAllPages())[0];
    await page.goto(url);
    await page.evaluate(() => localStorage.setItem("kept", "yes"));
    const originalProcess = service.getBrowserProcess()!;

    await service.endSession(ShutdownReason.SESSION_END, false);

    expect(originalProcess.exitCode !== null || originalProcess.signalCode !== null).toBe(true);
    await service.startNewSession(config);
    const restored = (await service.getAllPages())[0];
    await restored.goto(url);
    expect(
      await restored.evaluate(() => ({
        value: localStorage.getItem("kept"),
        initial: (window as any).savedAtLoad,
      })),
    ).toEqual({ value: "yes", initial: "yes" });
  }, 30_000);

  // The idle browser is relaunched on one profile after every release. Chrome
  // used to reopen the tabs of the previous run each time and add a new one.
  it("opens a single tab however many times the same profile has been launched", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "steel-profile-persistence-"));
    const downloadPath = path.join(directory, "downloads");
    await mkdir(downloadPath);
    const config = {
      options: {
        headless: true,
        args: ["--no-sandbox", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"],
      },
      userDataDir: path.join(directory, "profile"),
      downloadPath,
      timezone: Promise.resolve("UTC"),
      skipFingerprintInjection: true,
    };
    service = new CDPService(
      { primary: false, cdpPort: 0 },
      logger as unknown as FastifyBaseLogger,
      undefined,
      false,
    );
    const counts: number[] = [];
    for (let run = 0; run < 3; run++) {
      await service.startNewSession(config);
      counts.push((await service.getAllPages()).length);
      await service.endSession(ShutdownReason.SESSION_END, false);
    }
    expect(counts).toEqual([1, 1, 1]);
  }, 60_000);
});
