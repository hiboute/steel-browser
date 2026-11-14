import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { guardedCdp } from "./socket.js";
import { OwnershipService } from "./ownership.js";
import type { ConnectionCredential } from "./ownership.js";
const actor = { id: "agent", role: "agent" as const, authenticated: true };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
const listen = (server: http.Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as any).port)),
  );
const open = (ws: WebSocket) =>
  new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
const message = (ws: WebSocket) =>
  new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket message deadline")), 1000);
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
async function setup(delay = 0) {
  const control = new OwnershipService({
    read: async () => undefined,
    write: async () => {},
  } as any);
  await control.initialize();
  await control.registerResource("s", actor.id);
  const lease = await control.acquire("s", actor, { mode: "agent" });
  const credential: ConnectionCredential = {
    sessionId: "s",
    actor,
    token: lease.token,
    generation: lease.lease.generation,
  };
  const upstream = http.createServer(),
    upWss = new WebSocketServer({ noServer: true });
  const received: any[] = [];
  upstream.on("upgrade", (req, socket, head) =>
    setTimeout(
      () =>
        upWss.handleUpgrade(req, socket, head, (ws) =>
          ws.on("message", (data) => {
            const m = JSON.parse(data.toString());
            received.push(m);
            ws.send(JSON.stringify({ id: m.id, result: { method: m.method } }));
          }),
        ),
      delay,
    ),
  );
  const port = await listen(upstream);
  const gateway = http.createServer(),
    wss = new WebSocketServer({ noServer: true });
  gateway.on("upgrade", (req, socket, head) => {
    socket.pause();
    void guardedCdp(
      req,
      socket,
      head,
      wss,
      `ws://127.0.0.1:${port}`,
      control,
      req.url === "/observer" ? undefined : credential,
    );
  });
  const gatewayPort = await listen(gateway);
  cleanup.push(async () => {
    for (const ws of [...wss.clients, ...upWss.clients]) ws.terminate();
    await Promise.all([
      new Promise<void>((r) => gateway.close(() => r())),
      new Promise<void>((r) => upstream.close(() => r())),
    ]);
    wss.close();
    upWss.close();
    await control.close();
  });
  return {
    control,
    received,
    connect: (path = "/") => new WebSocket(`ws://127.0.0.1:${gatewayPort}${path}`),
  };
}
describe("guarded CDP transport", () => {
  it("resumes activity-paused upgrades and fences controller sockets after takeover", async () => {
    const s = await setup();
    const client = s.connect();
    await open(client);
    const response = message(client);
    client.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
    expect(await response).toMatchObject({ id: 1, result: { method: "Browser.getVersion" } });
    const closed = new Promise<void>((r) => client.once("close", () => r()));
    await s.control.transfer(
      "s",
      { id: "human", role: "operator", authenticated: true },
      undefined,
      { mode: "human" },
    );
    await closed;
    expect(s.received).toHaveLength(1);
  });
  it("allows observation but denies arbitrary evaluation and nested target writes", async () => {
    const s = await setup();
    const client = s.connect("/observer");
    await open(client);
    for (const method of ["Runtime.evaluate", "Target.sendMessageToTarget"]) {
      const reply = message(client);
      client.send(JSON.stringify({ id: 2, method, params: { expression: "sideEffect()" } }));
      expect(await reply).toMatchObject({ error: { code: -32000 } });
    }
    expect(s.received).toEqual([]);
  });
  it("answers a refused command on the target session it was sent on", async () => {
    const s = await setup();
    const client = s.connect("/observer");
    await open(client);
    const onPage = message(client);
    client.send(JSON.stringify({ id: 7, sessionId: "page-1", method: "Runtime.evaluate" }));
    // Without the sessionId, Playwright gets the reply on the browser session and its driver aborts.
    expect(await onPage).toEqual({
      id: 7,
      sessionId: "page-1",
      error: { code: -32000, message: "Current browser control is required" },
    });
    const onBrowser = message(client);
    client.send(JSON.stringify({ id: 8, method: "Runtime.evaluate" }));
    expect(await onBrowser).not.toHaveProperty("sessionId");
  });
  it("rechecks queued frames after upstream connection instead of replaying stale mutations", async () => {
    const s = await setup(150);
    const client = s.connect();
    await open(client);
    client.send(
      JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "sideEffect()" } }),
    );
    await new Promise((r) => setTimeout(r, 20));
    const closed = new Promise<void>((r) => client.once("close", () => r()));
    await s.control.transfer(
      "s",
      { id: "human", role: "operator", authenticated: true },
      undefined,
      { mode: "human" },
    );
    await closed;
    expect(s.received).toEqual([]);
  });
});
