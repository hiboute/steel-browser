import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import puppeteer, { type Browser } from "puppeteer-core";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

// Chrome resolves every *.localhost name to the loopback address, so a listed
// "tracker" can be served by the fixture below.
vi.hoisted(() => {
  process.env.BLOCK_ADS_EXTRA_HOSTS = "tracker.localhost";
  // The fixture is on the loopback address: this name plays the public site.
  process.env.PRIVATE_NETWORK_ALLOW_HOSTS = "public.localhost";
});

import type { BrowserLauncherOptions } from "../../types/browser.js";
import { getChromeExecutablePath } from "../../utils/browser.js";
import type { BlockKind } from "../../utils/requests.js";
import { CDPService } from "./cdp.service.js";
import { ShutdownReason } from "./plugins/core/base-plugin.js";

vi.mock("../file.service.js", () => ({
  FileService: {
    getInstance: () => ({
      cleanupFiles: vi.fn().mockResolvedValue(undefined),
      getBaseFilesPath: () => os.tmpdir(),
    }),
  },
}));

vi.mock("../timezone-fetcher.service.js", () => ({
  TimezoneFetcher: class {
    getTimezone() {
      return Promise.resolve("UTC");
    }
  },
}));

vi.mock("../../utils/extensions.js", () => ({
  getExtensionPaths: vi.fn().mockResolvedValue([]),
}));

const logger = {
  child: () => logger,
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};

const chrome = (() => {
  try {
    const executable = getChromeExecutablePath();
    return !!executable && fs.existsSync(executable);
  } catch {
    return false;
  }
})();

describe.skipIf(!chrome)("CDPService request filter in a real browser", () => {
  let dataDir: string;
  let server: http.Server;
  let port: number;
  let requests: string[] = [];
  const services: CDPService[] = [];
  const clients: Browser[] = [];

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "steel-filter-"));
    server = http.createServer((req, res) => {
      const host = (req.headers.host ?? "").split(":")[0];
      const url = req.url ?? "/";
      requests.push(`${host}${url.split("?")[0]}`);
      res.setHeader("cache-control", "no-store");
      if (url.startsWith("/t.js")) {
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end("window.tracker_ = 'loaded'");
      } else if (url.startsWith("/app.js")) {
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end("window.app_ = 'loaded'");
      } else if (url.startsWith("/style.css")) {
        res.writeHead(200, { "content-type": "text/css" });
        res.end("h1{color:rgb(1,2,3)}");
      } else if (url.startsWith("/pic.png")) {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
            "base64",
          ),
        );
      } else if (url.startsWith("/font.woff2")) {
        res.writeHead(200, { "content-type": "font/woff2" });
        res.end(Buffer.alloc(32));
      } else if (url.startsWith("/hop")) {
        res.writeHead(302, { location: `http://127.0.0.1:${port}/secret` });
        res.end();
      } else if (url.startsWith("/secret")) {
        res.writeHead(200, { "content-type": "text/html", "access-control-allow-origin": "*" });
        res.end("<!doctype html><title>secret</title>internal");
      } else if (url.startsWith("/plain")) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<!doctype html><title>plain</title><h1>Plain</h1>");
      } else if (url.startsWith("/retry")) {
        // What some sites do: on error, ask for a placeholder, again and again.
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><title>retry</title><script>window.errors_ = 0</script>
          <img src="/pic.png" onerror="window.errors_++; if (window.errors_ < 50) this.src = '/pic.png?again=' + window.errors_">`);
      } else {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><title>${host}</title>
          <style>@font-face{font-family:Fx;src:url(/font.woff2)} h1{font-family:Fx}</style>
          <link rel="stylesheet" href="/style.css">
          <script src="http://tracker.localhost:${port}/t.js"></script>
          <script src="/app.js"></script>
          <h1>Fixture</h1><img src="/pic.png">`);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.disconnect().catch(() => {});
    for (const service of services.splice(0))
      await service.shutdown(ShutdownReason.SESSION_END).catch(() => {});
    requests = [];
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function start(config: Partial<BrowserLauncherOptions> = {}) {
    const blocked: [BlockKind, string][] = [];
    const service = new CDPService({}, logger as unknown as FastifyBaseLogger, undefined, false);
    services.push(service);
    await service.startNewSession({
      options: {
        headless: true,
        args: ["--no-sandbox", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"],
      },
      skipFingerprintInjection: true,
      userDataDir: fs.mkdtempSync(path.join(dataDir, "profile-")),
      onRequestBlocked: (kind, url) => {
        // Chrome asks for the favicon on its own; with images off it is refused too.
        const pathname = new URL(url).pathname;
        if (pathname !== "/favicon.ico") blocked.push([kind, pathname]);
      },
      ...config,
    });
    const client = await puppeteer.connect({
      browserWSEndpoint: service.getBrowserInstance()!.wsEndpoint(),
      defaultViewport: null,
    });
    clients.push(client);
    return { client, blocked };
  }

  /** What a CDP client does: a new tab, navigated at once. */
  async function open(client: Browser, url = `http://localhost:${port}/`) {
    const page = await client.newPage();
    await page.goto(url, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready.then(() => undefined)).catch(() => undefined);
    return page;
  }

  const state = (page: Awaited<ReturnType<typeof open>>) =>
    page.evaluate(() => ({
      tracker: (window as any).tracker_ ?? null,
      app: (window as any).app_ ?? null,
      image: (document.querySelector("img") as HTMLImageElement | null)?.naturalWidth ?? 0,
      color: getComputedStyle(document.querySelector("h1")!).color,
    }));

  test("blockAds refuses a listed host in a tab that is navigated as soon as it exists", async () => {
    const { client, blocked } = await start({ blockAds: true });
    for (let round = 0; round < 3; round++) {
      const page = await open(client);
      expect(await state(page)).toEqual({
        tracker: null,
        app: "loaded",
        image: 1,
        color: "rgb(1, 2, 3)",
      });
    }
    expect(requests.filter((entry) => entry.startsWith("tracker.localhost"))).toEqual([]);
    expect(blocked).toEqual([
      ["ads", "/t.js"],
      ["ads", "/t.js"],
      ["ads", "/t.js"],
    ]);
  }, 60000);

  test("blockAds still opens a listed host when the session navigates to it", async () => {
    const { client, blocked } = await start({ blockAds: true });
    const page = await open(client, `http://tracker.localhost:${port}/`);
    expect(await page.title()).toBe("tracker.localhost");
    // Its own script is first-party there; nothing is refused.
    expect((await state(page)).tracker).toBe("loaded");
    expect(blocked).toEqual([]);
  }, 60000);

  test("skips images and fonts, and nothing else, for saveData", async () => {
    const { client, blocked } = await start({
      optimizeBandwidth: { blockImages: true, blockMedia: true, blockFonts: true },
    });
    const page = await open(client);
    expect(await state(page)).toEqual({
      tracker: "loaded",
      app: "loaded",
      // The empty image that stands in for the skipped one.
      image: 1,
      color: "rgb(1, 2, 3)",
    });
    expect(requests).not.toContain("localhost/pic.png");
    expect(requests).not.toContain("localhost/font.woff2");
    expect(requests).toContain("localhost/style.css");
    expect(blocked.map(([kind]) => kind).sort()).toEqual(["fonts", "images"]);
  }, 60000);

  test("a skipped image is answered, so a page that retries on error does not loop", async () => {
    const { client, blocked } = await start({ optimizeBandwidth: { blockImages: true } });
    const page = await open(client, `http://localhost:${port}/retry`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await page.evaluate(() => (window as any).errors_)).toBe(0);
    expect(requests.filter((entry) => entry.includes("pic.png"))).toEqual([]);
    expect(blocked).toEqual([["images", "/pic.png"]]);
  }, 60000);

  test("blockPrivateNetwork refuses a private address a page asks for", async () => {
    const { client, blocked } = await start({ blockPrivateNetwork: true });
    const page = await open(client, `http://public.localhost:${port}/plain`);
    expect(await page.title()).toBe("plain");
    const outcome = await page.evaluate(
      (target) =>
        fetch(target).then(
          (response) => `answered ${response.status}`,
          () => "refused",
        ),
      `http://127.0.0.1:${port}/secret`,
    );
    expect(outcome).toBe("refused");
    expect(requests).not.toContain("127.0.0.1/secret");
    expect(blocked).toEqual([["private", "/secret"]]);
  }, 60000);

  test("blockPrivateNetwork refuses a navigation and the hop of a redirect", async () => {
    const { client, blocked } = await start({ blockPrivateNetwork: true });
    const page = await client.newPage();
    await expect(page.goto(`http://127.0.0.1:${port}/secret`)).rejects.toThrow(
      /ERR_BLOCKED_BY_CLIENT/,
    );
    await expect(page.goto(`http://public.localhost:${port}/hop`)).rejects.toThrow(
      /ERR_BLOCKED_BY_CLIENT/,
    );
    expect(requests).toContain("public.localhost/hop");
    expect(requests).not.toContain("127.0.0.1/secret");
    expect(blocked).toEqual([
      ["private", "/secret"],
      ["private", "/secret"],
    ]);
  }, 60000);

  test("blockPrivateNetwork refuses the first request of a popup", async () => {
    const { client, blocked } = await start({ blockPrivateNetwork: true });
    const page = await open(client, `http://public.localhost:${port}/plain`);
    const popup = new Promise<void>((resolve) => client.once("targetcreated", () => resolve()));
    await page.evaluate((target) => {
      window.open(target, "_blank");
    }, `http://127.0.0.1:${port}/secret`);
    await popup;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(requests).not.toContain("127.0.0.1/secret");
    expect(blocked).toEqual([["private", "/secret"]]);
  }, 60000);

  test("a session without blockPrivateNetwork still reaches private addresses", async () => {
    const { client, blocked } = await start({ blockAds: true });
    const page = await open(client, `http://public.localhost:${port}/hop`);
    expect(await page.title()).toBe("secret");
    expect(blocked).toEqual([]);
  }, 60000);

  test("leaves a browser without options alone, next to one that filters", async () => {
    const filtered = await start({ blockAds: true, optimizeBandwidth: { blockImages: true } });
    const plain = await start();
    const [a, b] = await Promise.all([open(filtered.client), open(plain.client)]);
    expect(await state(a)).toMatchObject({ tracker: null });
    expect(await state(b)).toEqual({
      tracker: "loaded",
      app: "loaded",
      image: 1,
      color: "rgb(1, 2, 3)",
    });
    expect(plain.blocked).toEqual([]);
    expect(filtered.blocked.map(([kind]) => kind).sort()).toEqual(["ads", "images"]);
  }, 60000);
});
