import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import puppeteer, { type Browser } from "puppeteer-core";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { PlatformStore } from "../platform/store.js";
import { BrowserEgressDiagnostics } from "../fleet/egress-diagnostics.js";
import { DoctorService } from "./doctor.service.js";

const chrome =
  process.env.CHROME_EXECUTABLE_PATH ||
  (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
const actor = { id: "doctor-test", role: "agent" as const, authenticated: true };
let directory: string | undefined,
  browser: Browser | undefined,
  server: Server | undefined,
  sockets: WebSocketServer | undefined;
const start = async (s: Server) => {
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};
afterEach(async () => {
  await browser?.close();
  browser = undefined;
  for (const socket of sockets?.clients ?? []) socket.terminate();
  if (sockets) await new Promise<void>((resolve) => sockets!.close(() => resolve()));
  sockets = undefined;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  server = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});
async function setup(origin: string, args: string[] = [], proxyUrl?: string) {
  directory = await mkdtemp(path.join(os.tmpdir(), "steel-doctor-browser-"));
  const store = new PlatformStore(directory, "test-key");
  browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", ...args],
  });
  const session = {
    id: "owned",
    status: "live",
    cdpService: { getBrowserInstance: () => browser!, createPage: () => browser!.newPage() },
  };
  const sessions = { getSession: () => session, getLaunchOptions: () => ({ proxyUrl }) } as any;
  return {
    store,
    session,
    diagnostics: new BrowserEgressDiagnostics(sessions, store, origin),
    doctor: new DoctorService(store, sessions),
  };
}

describe.skipIf(!chrome)("failure doctor with real browser-origin evidence", () => {
  it("distinguishes a real collector outage from a proxy outage and leaves the application page unchanged", async () => {
    let fail = false;
    server = createServer((req, res) => {
      const url = new URL(req.url!, "http://fixture");
      if (url.pathname === "/observe") {
        res.setHeader("Content-Type", "application/json");
        if (fail) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: "collector unavailable", token: "never-persist-this" }));
        } else
          res.end(
            JSON.stringify({
              nonce: url.searchParams.get("nonce"),
              ip: "192.0.2.1",
              headers: { authorization: "never-persist-this" },
            }),
          );
      } else if (url.pathname === "/worker.js") {
        res.setHeader("Content-Type", "text/javascript");
        res.end(
          `fetch('/observe?nonce=' + new URL(location.href).searchParams.get('nonce')).then(r=>r.json()).then(value=>postMessage(value.error?{error:true}:value));`,
        );
      } else {
        res.setHeader("Content-Type", "text/html");
        res.end(
          '<title>Owned application</title><input type="password" value="never-persist-this"><div data-steel-application-error></div>',
        );
      }
    });
    sockets = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      if (fail) {
        socket.destroy();
        return;
      }
      sockets!.handleUpgrade(req, socket, head, (ws) =>
        ws.send(
          JSON.stringify({
            nonce: new URL(req.url!, "http://fixture").searchParams.get("nonce"),
            ip: "192.0.2.1",
          }),
        ),
      );
    });
    const origin = await start(server);
    const { diagnostics, doctor } = await setup(origin);
    const [page] = await browser!.pages();
    await page.goto(origin);
    await page.evaluate(() => {
      sessionStorage.setItem("draft", "unchanged");
      document.title = "Keep this page";
    });
    const success = await diagnostics.run("owned");
    expect(success.probes).toContainEqual(
      expect.objectContaining({ channel: "http", status: "pass" }),
    );
    expect((await doctor.diagnose("owned", actor)).observations).toContainEqual(
      expect.objectContaining({ component: "network_http", status: "pass" }),
    );
    fail = true;
    const outage = await diagnostics.run("owned");
    expect(outage.probes).toContainEqual(
      expect.objectContaining({ channel: "http", status: "fail" }),
    );
    const report = await doctor.diagnose("owned", actor);
    expect(report.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ component: "network_http", status: "fail" }),
        expect.objectContaining({
          component: "authentication",
          status: "fail",
          confidence: "medium",
        }),
        expect.objectContaining({ component: "application", status: "fail", confidence: "high" }),
      ]),
    );
    expect(report.observations.some((o) => o.component === "proxy" && o.status === "fail")).toBe(
      false,
    );
    expect(JSON.stringify(report)).not.toMatch(
      /never-persist|192\.0\.2|127\.0\.0\.1|authorization/,
    );
    expect(await browser!.pages()).toHaveLength(1);
    expect(await page.evaluate(() => [document.title, sessionStorage.getItem("draft")])).toEqual([
      "Keep this page",
      "unchanged",
    ]);
  });
  it("records real connection refusal without falsely declaring a proxy or DNS cause", async () => {
    server = createServer();
    const origin = await start(server);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    const { diagnostics, doctor } = await setup(origin);
    const evidence = await diagnostics.run("owned");
    expect(evidence.navigationFailure).toBe("connection_refused");
    const report = await doctor.diagnose("owned", actor);
    expect(report.observations).toContainEqual(
      expect.objectContaining({ component: "network_http", status: "fail" }),
    );
    expect(report.observations).toContainEqual(
      expect.objectContaining({ component: "dns", status: "untested" }),
    );
  });
  it("records a real refused proxy connection as proxy failure without storing credentials", async () => {
    server = createServer();
    const proxy = await start(server);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    const { diagnostics, doctor } = await setup(
      "http://owned-fixture.localhost:8765",
      [`--proxy-server=${proxy}`, "--proxy-bypass-list=<-loopback>"],
      proxy,
    );
    const evidence = await diagnostics.run("owned");
    expect(evidence.navigationFailure).toBe("proxy_connection_failed");
    const report = await doctor.diagnose("owned", actor);
    expect(report.observations).toContainEqual(
      expect.objectContaining({ component: "proxy", status: "fail", confidence: "high" }),
    );
    expect(JSON.stringify(report)).not.toContain(proxy);
  });
  it("classifies Chrome's deterministic local-fixture DNS refusal separately from API-host DNS", async () => {
    const { diagnostics, doctor } = await setup("http://doctor-fixture.localhost", [
      "--host-resolver-rules=MAP doctor-fixture.localhost ~NOTFOUND",
    ]);
    const evidence = await diagnostics.run("owned");
    expect(evidence.navigationFailure).toBe("name_resolution_failed");
    const report = await doctor.diagnose("owned", actor);
    expect(report.observations).toContainEqual(
      expect.objectContaining({ component: "dns", status: "fail", confidence: "high" }),
    );
    expect(JSON.stringify(report)).not.toContain("doctor-fixture.localhost");
  });
});
