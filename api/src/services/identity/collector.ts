import { createServer, type Server } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import type { Browser, Page } from "puppeteer-core";

export type Check = { name: string; status: "pass" | "fail" | "untested"; detail?: string };
const allowedHeaders = [
  "user-agent",
  "accept-language",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "sec-ch-ua-full-version-list",
  "sec-ch-ua-platform-version",
  "sec-ch-ua-model",
];
export class IdentityCollector {
  constructor(private externalOrigin = process.env.STEEL_DIAGNOSTICS_COLLECTOR) {}
  private server?: Server;
  private starting?: Promise<string>;
  private origin?: string;
  private readonly nonce = randomBytes(24).toString("hex");
  async start(): Promise<string> {
    if (this.origin) return this.origin;
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (!url.pathname.startsWith(`/${this.nonce}/`)) {
          res.writeHead(404).end();
          return;
        }
        const route = url.pathname.slice(this.nonce.length + 2);
        res.setHeader("Cache-Control", "no-store");
        res.setHeader(
          "Accept-CH",
          "Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version, Sec-CH-UA-Model",
        );
        if (route === "headers") {
          const headers = Object.fromEntries(
            allowedHeaders.flatMap((k) =>
              typeof req.headers[k] === "string"
                ? [[k, String(req.headers[k]).slice(0, 2048)]]
                : [],
            ),
          );
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(headers));
          return;
        }
        if (route === "classic.js") {
          res.setHeader("Content-Type", "text/javascript");
          res.end("postMessage({ok:true,ua:navigator.userAgent});");
          return;
        }
        if (route === "module.js") {
          res.setHeader("Content-Type", "text/javascript");
          res.end(
            "import {value} from './value.js';postMessage({ok:value===42,ua:navigator.userAgent});",
          );
          return;
        }
        if (route === "value.js") {
          res.setHeader("Content-Type", "text/javascript");
          res.end("export const value=42;");
          return;
        }
        if (route === "service.js") {
          res.setHeader("Content-Type", "text/javascript");
          res.end(
            "self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));",
          );
          return;
        }
        if (route === "download") {
          res.setHeader("Content-Type", "text/plain");
          res.setHeader("Content-Disposition", 'attachment; filename="fixture.txt"');
          res.end("Steel owned download fixture");
          return;
        }
        if (route === "frame") {
          res.setHeader("Content-Type", "text/html");
          res.end("<!doctype html><title>Owned frame</title><p>frame ready</p>");
          return;
        }
        if (route !== "fixture") {
          res.writeHead(404).end();
          return;
        }
        res.setHeader("Content-Type", "text/html");
        // Blob workers are intentionally excluded: rewriting Worker URLs must not silently bypass CSP.
        res.setHeader(
          "Content-Security-Policy",
          "default-src 'self'; script-src 'self' 'unsafe-inline'; worker-src 'self'; frame-src 'self' http://localhost:* http://127.0.0.1:*; style-src 'self' 'unsafe-inline'",
        );
        res.end(
          `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Steel owned compatibility fixture</title><style>body{font:16px sans-serif}input,button{padding:10px;margin:10px}</style><h1>Compatibility fixture</h1><input id="keyboard" aria-label="Keyboard"><button id="touch" onclick="this.dataset.clicked='yes'" ontouchstart="this.dataset.touched='yes'">Touch target</button><a href="download" id="download" download>Owned download</a><iframe src="frame" id="same-frame"></iframe>`,
        );
      });
      this.server.requestTimeout = 5000;
      this.server.headersTimeout = 5000;
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        const address = this.server!.address();
        if (!address || typeof address === "string")
          return reject(new Error("Collector failed to bind"));
        this.origin = `http://127.0.0.1:${address.port}/${this.nonce}/`;
        resolve(this.origin);
      });
    });
    return this.starting;
  }
  async close() {
    await this.starting?.catch(() => undefined);
    if (this.server) {
      this.server.closeAllConnections();
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
    this.origin = undefined;
    this.starting = undefined;
  }
  async open(browser: Browser, preparePage?: (page: Page) => Promise<void>): Promise<Page> {
    const page = await browser.newPage();
    try {
      await preparePage?.(page);
      await page.goto(`${await this.start()}fixture`, { waitUntil: "load", timeout: 7000 });
      return page;
    } catch (e) {
      await page.close().catch(() => undefined);
      throw e;
    }
  }
  async headers(browser: Browser, preparePage?: (page: Page) => Promise<void>) {
    let page: Page | undefined;
    try {
      let value: Record<string, unknown>;
      if (this.externalOrigin) {
        const u = new URL("/observe", this.externalOrigin);
        if (!["https:", "http:"].includes(u.protocol) || u.username || u.password)
          throw new Error("Invalid collector origin");
        u.searchParams.set("nonce", randomUUID());
        page = await browser.newPage();
        await preparePage?.(page);
        await page.goto(u.href, { waitUntil: "load", timeout: 7000 });
        value = await page.evaluate(() => JSON.parse(document.body.innerText).headers);
      } else {
        page = await this.open(browser, preparePage);
        value = await page.evaluate(async () => {
          const r = await fetch("headers");
          return await r.json();
        });
      }
      const headers = Object.fromEntries(
        allowedHeaders.flatMap((k) =>
          typeof value?.[k] === "string" ? [[k, String(value[k]).slice(0, 2048)]] : [],
        ),
      );
      return { status: "measured" as const, headers };
    } catch {
      return {
        status: "unavailable" as const,
        reason: "Owned diagnostic collector was not reachable from this browser",
      };
    } finally {
      await page?.close().catch(() => undefined);
    }
  }
}

/** Runs in the page; returns only browser capability observations, never page text or user data. */
export async function observe(page: Page) {
  return await page.evaluate(async () => {
    const n = navigator as Navigator & {
      userAgentData?: {
        brands: unknown;
        mobile: boolean;
        platform: string;
        getHighEntropyValues: (keys: string[]) => Promise<unknown>;
      };
      deviceMemory?: number;
    };
    const fontCanvas = document.createElement("canvas");
    const fontContext = fontCanvas.getContext("2d");
    const fontAvailable = (font: string) => {
      if (!fontContext) return false;
      const sample = "mmmmmmmmlli0123456789";
      return ["monospace", "serif", "sans-serif"].some((base) => {
        fontContext.font = `72px ${base}`;
        const fallback = fontContext.measureText(sample).width;
        fontContext.font = `72px "${font}",${base}`;
        return fontContext.measureText(sample).width !== fallback;
      });
    };
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    let entropy: unknown = null;
    try {
      entropy = await n.userAgentData?.getHighEntropyValues([
        "architecture",
        "bitness",
        "model",
        "platformVersion",
        "uaFullVersion",
        "fullVersionList",
      ]);
    } catch {}
    return {
      userAgent: n.userAgent,
      platform: n.platform,
      languages: [...n.languages],
      language: n.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      clientHints: n.userAgentData
        ? {
            brands: n.userAgentData.brands,
            mobile: n.userAgentData.mobile,
            platform: n.userAgentData.platform,
            highEntropy: entropy,
          }
        : null,
      screen: {
        width: screen.width,
        height: screen.height,
        availWidth: screen.availWidth,
        availHeight: screen.availHeight,
        innerWidth,
        innerHeight,
        dpr: devicePixelRatio,
        orientation: screen.orientation?.type ?? null,
      },
      touch: { maxTouchPoints: n.maxTouchPoints, coarse: matchMedia("(pointer: coarse)").matches },
      hardware: { concurrency: n.hardwareConcurrency, memory: n.deviceMemory ?? null },
      fonts: {
        method:
          "Canvas metric comparison against generic fallback fonts; metrically equivalent fonts may be indistinguishable",
        available: [
          "Arial",
          "Times New Roman",
          "Noto Sans",
          "DejaVu Sans",
          "Liberation Sans",
        ].filter(fontAvailable),
      },
      graphics: gl
        ? {
            vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
            renderer: ext
              ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
              : gl.getParameter(gl.RENDERER),
            version: gl.getParameter(gl.VERSION),
          }
        : null,
    };
  });
}

export async function fixtureChecks(page: Page): Promise<Check[]> {
  const results = await page.evaluate(async () => {
    const checks: { name: string; status: "pass" | "fail" | "untested"; detail?: string }[] = [];
    const check = async (name: string, fn: () => unknown | Promise<unknown>) => {
      try {
        checks.push({ name, status: (await fn()) ? "pass" : "fail" });
      } catch {
        checks.push({ name, status: "fail", detail: "Fixture operation threw" });
      }
    };
    await check("navigator-descriptor", () => {
      const d = Object.getOwnPropertyDescriptor(Navigator.prototype, "userAgent");
      return !!d?.get && d.enumerable && d.configurable;
    });
    await check("console-semantics", () => {
      console.debug("owned fixture");
      return typeof console.log === "function" && typeof console.debug === "function";
    });
    await check("invalid-worker-error", () => {
      try {
        new Worker("http://invalid.invalid/worker.js");
        return false;
      } catch (e) {
        return e instanceof DOMException;
      }
    });
    for (const type of ["classic", "module"] as const)
      await check(
        `${type}-worker-csp-relative-import`,
        () =>
          new Promise<boolean>((resolve) => {
            const w = new Worker(`${type}.js`, { type });
            const t = setTimeout(() => {
              w.terminate();
              resolve(false);
            }, 2500);
            w.onmessage = (e) => {
              clearTimeout(t);
              w.terminate();
              resolve(e.data.ok === true && e.data.ua === navigator.userAgent);
            };
            w.onerror = () => {
              clearTimeout(t);
              w.terminate();
              resolve(false);
            };
          }),
      );
    await check("same-origin-frame", () => {
      const frame = document.querySelector("iframe")!;
      return (
        frame.contentWindow?.navigator.userAgent === navigator.userAgent &&
        !!frame.contentDocument?.querySelector("p")
      );
    });
    await check(
      "cross-origin-frame",
      () =>
        new Promise<boolean>((resolve) => {
          const frame = document.createElement("iframe");
          const u = new URL("frame", location.href);
          u.hostname = location.hostname === "localhost" ? "127.0.0.1" : "localhost";
          frame.src = u.href;
          const t = setTimeout(() => {
            frame.remove();
            resolve(false);
          }, 2500);
          frame.onload = () => {
            clearTimeout(t);
            let denied = false;
            try {
              void frame.contentWindow!.document;
            } catch {
              denied = true;
            }
            frame.remove();
            resolve(denied);
          };
          document.body.append(frame);
        }),
    );
    await check("storage", () => {
      const key = "steel-owned-fixture";
      localStorage.setItem(key, "ok");
      sessionStorage.setItem(key, "ok");
      const ok = localStorage.getItem(key) === "ok" && sessionStorage.getItem(key) === "ok";
      localStorage.removeItem(key);
      sessionStorage.removeItem(key);
      return ok;
    });
    await check(
      "permissions-query",
      async () => !!(await navigator.permissions.query({ name: "geolocation" })).state,
    );
    await check("canvas", () => !!document.createElement("canvas").getContext("2d"));
    const gl = document.createElement("canvas").getContext("webgl");
    checks.push({
      name: "webgl",
      status: gl ? "pass" : "untested",
      ...(!gl ? { detail: "No WebGL context available in this runtime" } : {}),
    });
    await check("service-worker", async () => {
      if (!("serviceWorker" in navigator)) return false;
      const r = await navigator.serviceWorker.register("service.js");
      await r.unregister();
      return true;
    });
    const video = document.createElement("video");
    checks.push({
      name: "media-codecs",
      status: video.canPlayType('video/webm; codecs="vp8"') ? "pass" : "untested",
      detail: "Codec availability only; no physical camera or microphone exercised",
    });
    await check("download-response", async () => {
      const r = await fetch("download");
      return (
        r.headers.get("content-disposition")?.includes("fixture.txt") &&
        (await r.text()) === "Steel owned download fixture"
      );
    });
    return checks;
  });
  await page.type("#keyboard", "Steel keyboard fixture");
  results.push({
    name: "keyboard-input",
    status: (await page.$eval(
      "#keyboard",
      (e) => (e as HTMLInputElement).value === "Steel keyboard fixture",
    ))
      ? "pass"
      : "fail",
  });
  const mobile = await page.evaluate(() => navigator.maxTouchPoints > 0);
  if (mobile) {
    await page.tap("#touch");
    results.push({
      name: "touch-input",
      status: (await page.$eval("#touch", (e) => (e as HTMLElement).dataset.touched === "yes"))
        ? "pass"
        : "fail",
    });
  } else
    results.push({
      name: "touch-input",
      status: "untested",
      detail: "Desktop session has no emulated touch",
    });
  return results;
}
