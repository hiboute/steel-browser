import { gzipSync } from "node:zlib";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  assertAllowedUrl,
  extrasAllowPrivateNetworks,
  isPublicAddress,
  NavigationPolicyError,
  withNavigationPolicy,
} from "./navigation-policy.js";

const publicResolver = async () => ["8.8.8.8"];
afterEach(() => vi.unstubAllEnvs());
describe("server-initiated navigation destination policy", () => {
  it("allows public unicast addresses and rejects special-use IPv4/IPv6 including mapped addresses", () => {
    for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])
      expect(isPublicAddress(address), address).toBe(true);
    for (const address of [
      "0.0.0.0",
      "10.0.0.1",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.1.1",
      "192.0.0.1",
      "192.0.2.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "fe80::1",
      "fc00::1",
      "ff02::1",
      "2001:db8::1",
      "2002:7f00:1::",
      "64:ff9b::7f00:1",
      "3fff::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:10.0.0.1",
      "not-an-ip",
    ])
      expect(isPublicAddress(address), address).toBe(false);
  });
  it("rejects non-HTTP top-level URLs, credentials, metadata names and canonicalized private literals", async () => {
    for (const url of [
      "file:///etc/passwd",
      "data:text/html,hello",
      "blob:https://example.org/id",
      "ftp://example.org/a",
      "http://a:b@example.org",
      "http://localhost",
      "http://a.localhost",
      "http://metadata.google.internal",
      "http://2130706433",
      "http://0177.0.0.1",
      "http://[::ffff:7f00:1]",
    ])
      await expect(
        assertAllowedUrl(url, { resolve: publicResolver, allowPrivateNetworks: false }),
        url,
      ).rejects.toBeInstanceOf(NavigationPolicyError);
  });
  it("permits inert data/blob subresources while still denying non-web schemes", async () => {
    await expect(assertAllowedUrl("data:image/png;base64,AA", {}, false)).resolves.toContain(
      "data:",
    );
    await expect(assertAllowedUrl("blob:https://example.org/id", {}, false)).resolves.toContain(
      "blob:",
    );
    await expect(assertAllowedUrl("file:///etc/passwd", {}, false)).rejects.toThrow();
  });
  it("checks every DNS answer and resolves afresh for every request", async () => {
    const resolve = vi
      .fn()
      .mockResolvedValueOnce(["8.8.8.8"])
      .mockResolvedValueOnce(["8.8.8.8", "::ffff:10.0.0.1"]);
    await expect(assertAllowedUrl("https://public.example/first", { resolve })).resolves.toBe(
      "https://public.example/first",
    );
    await expect(assertAllowedUrl("https://public.example/second", { resolve })).rejects.toThrow(
      "reserved",
    );
    expect(resolve).toHaveBeenCalledTimes(2);
    for (const addresses of [[], ["invalid"], ["127.0.0.1"]])
      await expect(
        assertAllowedUrl("https://public.example", { resolve: async () => addresses }),
      ).rejects.toThrow();
  });
  it("fails closed on DNS errors/timeouts without revealing input credentials", async () => {
    await expect(
      assertAllowedUrl("https://example.org", {
        resolve: async () => {
          throw new Error("secret details");
        },
      }),
    ).rejects.toThrow("could not be verified");
    await expect(
      assertAllowedUrl("https://example.org", {
        resolve: () => new Promise(() => {}),
        dnsTimeoutMs: 5,
      }),
    ).rejects.toThrow("could not be verified");
    try {
      await assertAllowedUrl("https://secret:credential@example.org");
    } catch (error) {
      expect(String(error)).not.toContain("credential@");
    }
  });
  it("requires explicit private-network opt-in and retains scheme and credential restrictions", async () => {
    vi.stubEnv("EXTRAS_ALLOW_PRIVATE_NETWORKS", "false");
    expect(extrasAllowPrivateNetworks()).toBe(false);
    await expect(assertAllowedUrl("http://127.0.0.1")).rejects.toThrow();
    vi.stubEnv("EXTRAS_ALLOW_PRIVATE_NETWORKS", "true");
    await expect(assertAllowedUrl("http://127.0.0.1")).resolves.toBe("http://127.0.0.1/");
    await expect(assertAllowedUrl("file:///tmp/file")).rejects.toThrow();
    await expect(assertAllowedUrl("http://a:b@127.0.0.1")).rejects.toThrow();
    vi.stubEnv("EXTRAS_ALLOW_PRIVATE_NETWORKS", "typo");
    expect(extrasAllowPrivateNetworks).toThrow();
  });
});

const chrome = process.env.CHROME_EXECUTABLE_PATH || "/usr/bin/chromium";
describe.skipIf(!existsSync(chrome))("real Chromium navigation interception", () => {
  let browser: Browser;
  let page: Page;
  let port: number;
  const hits: string[] = [];
  let websocketHits = 0;
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    hits.push(`${req.headers.host}${url}`);
    if (url === "/redirect") {
      res.writeHead(302, { Location: `http://private.test:${port}/private-redirect` });
      res.end();
      return;
    }
    if (url === "/sw.js") {
      res.setHeader("Content-Type", "application/javascript");
      res.end(
        "self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(clients.claim()));self.addEventListener('fetch',e=>e.respondWith(new Response('worker intercepted')));",
      );
      return;
    }
    res.setHeader("Content-Type", "text/html");
    if (url === "/gzip") {
      res.setHeader("Content-Encoding", "gzip");
      res.end(gzipSync("<html><p>Compressed content preserved</p></html>"));
      return;
    }
    if (url === "/iframe")
      res.end(`<iframe src="http://private.test:${port}/private-frame"></iframe>`);
    else if (url === "/oopif") res.end(`<iframe src="http://other.test:${port}/child"></iframe>`);
    else if (url === "/child") res.end(`<img src="http://private.test:${port}/private-image">`);
    else if (url === "/connections")
      res.end(
        `<script>new WebSocket('ws://127.0.0.1:${port}/socket'); new Worker('/worker.js')</script>`,
      );
    else res.end("<html><title>Fixture</title><p>Public page</p></html>");
  });
  server.on("upgrade", (_req, socket) => {
    websocketHits++;
    socket.end();
  });
  const options = {
    allowPrivateNetworks: false,
    resolve: async (hostname: string) =>
      hostname === "private.test" ? ["127.0.0.1"] : ["8.8.8.8"],
  };
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
    browser = await puppeteer.launch({
      executablePath: chrome,
      headless: true,
      args: [
        "--no-sandbox",
        "--no-proxy-server",
        "--site-per-process",
        "--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebRTC,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights",
        "--host-resolver-rules=MAP public.test 127.0.0.1, MAP private.test 127.0.0.1, MAP other.test 127.0.0.1",
      ],
    });
  });
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  afterEach(async () => {
    await page?.close();
    hits.length = 0;
    websocketHits = 0;
  });
  const open = async () => {
    page = await browser.newPage();
    // This is the legacy interception style used by CDPService: immediate continue.
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (!request.isInterceptResolutionHandled()) void request.continue();
    });
    return page;
  };
  const navigate = async (path: string) => {
    await page.goto(`http://public.test:${port}${path}`, {
      waitUntil: "networkidle0",
      timeout: 8000,
    });
  };
  it("blocks a direct private request despite an earlier legacy continue handler and restores the page afterward", async () => {
    await open();
    await expect(
      withNavigationPolicy(
        page,
        async () => page.goto(`http://127.0.0.1:${port}/private`),
        options,
      ),
    ).rejects.toMatchObject({ code: "blocked_target" });
    expect(hits).toHaveLength(0);
    await page.goto(`http://127.0.0.1:${port}/restored`);
    expect(hits.some((hit) => hit.endsWith("/restored"))).toBe(true);
  });
  it("checks redirect destinations before the private server receives a request", async () => {
    await open();
    await expect(
      withNavigationPolicy(page, async () => navigate("/redirect"), options),
    ).rejects.toBeInstanceOf(NavigationPolicyError);
    expect(hits.some((hit) => hit.endsWith("/redirect"))).toBe(true);
    expect(hits.some((hit) => hit.includes("private-redirect"))).toBe(false);
  });
  it("checks iframe navigations and propagates a blocked subframe even when the main document loads", async () => {
    await open();
    await expect(
      withNavigationPolicy(page, async () => navigate("/iframe"), options),
    ).rejects.toBeInstanceOf(NavigationPolicyError);
    expect(hits.some((hit) => hit.includes("private-frame"))).toBe(false);
  });
  it("secures resources from a cross-origin out-of-process iframe", async () => {
    await open();
    await expect(
      withNavigationPolicy(page, async () => navigate("/oopif"), options),
    ).rejects.toBeInstanceOf(NavigationPolicyError);
    expect(hits.some((hit) => hit.endsWith("/child"))).toBe(true);
    expect(hits.some((hit) => hit.includes("private-image"))).toBe(false);
  });
  it("blocks WebSocket handshakes and new workers in newly loaded job documents", async () => {
    await open();
    await withNavigationPolicy(page, async () => navigate("/connections"), options);
    expect(websocketHits).toBe(0);
    expect(hits.some((hit) => hit.includes("worker.js"))).toBe(false);
  });
  it("loads HTTP/2-style responses without a reason phrase while applying the guard", async () => {
    await open();
    const createSession = page.createCDPSession.bind(page);
    let simulatedHttp2 = false;
    page.createCDPSession = async () => {
      const client = await createSession();
      // HTTP/2 has no reason phrase. Preserve the real request/body and reproduce the
      // empty CDP responseStatusText returned by production Chrome for HTTPS sites.
      client.on("Fetch.requestPaused", (event) => {
        if (event.responseStatusCode !== undefined) {
          event.responseStatusText = "";
          simulatedHttp2 = true;
        }
      });
      return client;
    };
    await withNavigationPolicy(
      page,
      async () => {
        await navigate("/");
        expect(await page.evaluate(() => document.body.innerText)).toBe("Public page");
      },
      options,
    );
    expect(simulatedHttp2).toBe(true);
  });
  it("preserves compressed document content while installing the response policy", async () => {
    await open();
    await withNavigationPolicy(
      page,
      async () => {
        await navigate("/gzip");
        expect(await page.evaluate(() => document.body.innerText)).toBe(
          "Compressed content preserved",
        );
      },
      options,
    );
  });
  it("bypasses an existing service worker during a job and restores normal routing afterward", async () => {
    await open();
    const url = `http://127.0.0.1:${port}`;
    await page.goto(url);
    await page.evaluate(async () => {
      await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller)
        await new Promise<void>((resolve) =>
          navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), {
            once: true,
          }),
        );
    });
    await page.goto(`${url}/before`);
    expect(await page.evaluate(() => document.body.innerText)).toBe("worker intercepted");
    await withNavigationPolicy(
      page,
      async () => {
        await page.goto(`${url}/during`);
        expect(await page.evaluate(() => document.body.innerText)).toBe("Public page");
      },
      { allowPrivateNetworks: true },
    );
    await page.goto(`${url}/after`);
    expect(await page.evaluate(() => document.body.innerText)).toBe("worker intercepted");
    await page.evaluate(async () => {
      for (const registration of await navigator.serviceWorker.getRegistrations())
        await registration.unregister();
    });
  });
  it("cleans up interception when application work fails", async () => {
    await open();
    await expect(
      withNavigationPolicy(
        page,
        async () => {
          throw new Error("application failed");
        },
        options,
      ),
    ).rejects.toThrow("application failed");
    await page.goto(`http://127.0.0.1:${port}/restored`);
    expect(hits.some((hit) => hit.endsWith("/restored"))).toBe(true);
  });
});
