import Fastify from "fastify";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import devtoolsRoutes from "../../modules/next-platform/devtools.routes.js";
import { AccessService } from "./access.js";
import { OwnershipService } from "./ownership.js";
import { devtoolsAssetUrl, scopedCdpEndpoint } from "./devtools.js";
const actor = { id: "agent", role: "agent" as const, authenticated: true };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function setup() {
  const upstream = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(
      `<meta http-equiv="Content-Security-Policy" content="connect-src 'self';"><script src="./entry.js"></script>`,
    );
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const port = (upstream.address() as any).port;
  const control = new OwnershipService({
    read: async () => undefined,
    write: async () => {},
  } as any);
  await control.initialize();
  await control.registerResource("s", actor.id);
  await control.registerResource("other", "stranger");
  const app = Fastify();
  app.decorate("control", control);
  const access = new AccessService(
    (id) => control.readers(id),
    (id, actor, token) => control.assert(id, actor, token),
    { "long-enough-agent-api-token-for-test": actor },
  );
  app.decorate("access", access);
  app.addHook("onRequest", async (req) => {
    req.steelPrincipal = access.authenticate(req);
  });
  const service = {
    getWsEndpoint: () => `ws://127.0.0.1:${port}/devtools/browser/browser-id`,
    getAllPages: async () => [{}],
    getTargetId: () => "page-id",
  };
  app.decorate("sessionService", {
    getSession: (id: string) => ({ id, status: "live", cdpService: service }),
  } as any);
  await app.register(devtoolsRoutes, { prefix: "/v1" });
  await app.ready();
  cleanup.push(async () => {
    await app.close();
    await control.close();
    await new Promise<void>((r) => upstream.close(() => r()));
  });
  return {
    app,
    control,
    service,
    auth: { authorization: "Bearer long-enough-agent-api-token-for-test" },
  };
}
describe("scoped DevTools", () => {
  it("binds frontend navigation to a current ticket and preserves it for the scoped websocket", async () => {
    const { app, control, auth } = await setup();
    const lease = await control.acquire("s", actor, { mode: "agent" });
    const ticket = control.issueTicket("s", actor, lease.token, "cdp");
    const response = await app.inject({
      url: `/v1/sessions/s/devtools?controlTicket=${ticket.ticket}`,
      headers: auth,
    });
    expect(response.statusCode, response.body).toBe(302);
    expect(response.headers.location).toContain("/v1/sessions/s/devtools/inspector.html?");
    const target = new URL(response.headers.location!, "http://localhost");
    const socket = target.searchParams.get("ws")!;
    expect(socket).toContain("/v1/sessions/s/cdp?pageId=page-id&controlTicket=");
    expect(control.consumeTicket(ticket.ticket, "s", "cdp").generation).toBe(
      lease.lease.generation,
    );
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
  });
  it("rejects observer/stale tickets and targets from another browser", async () => {
    const { app, control, auth, service } = await setup();
    const observer = control.issueObserverTicket("s", actor);
    expect(
      (
        await app.inject({
          url: `/v1/sessions/s/devtools?controlTicket=${observer.ticket}`,
          headers: auth,
        })
      ).statusCode,
    ).toBe(403);
    const lease = await control.acquire("s", actor, { mode: "agent" });
    const ticket = control.issueTicket("s", actor, lease.token, "cdp");
    expect(
      (
        await app.inject({
          url: `/v1/sessions/other/devtools?controlTicket=${ticket.ticket}`,
          headers: auth,
        })
      ).statusCode,
    ).toBe(403);
    await expect(scopedCdpEndpoint(service as any, "foreign-page")).rejects.toMatchObject({
      code: "page_not_found",
    });
    await control.release("s", actor, lease.token);
    expect(
      (
        await app.inject({
          url: `/v1/sessions/s/devtools?controlTicket=${ticket.ticket}`,
          headers: auth,
        })
      ).statusCode,
    ).toBe(409);
  });
  it("proxies only authenticated static assets and refuses traversal into raw Chrome APIs", async () => {
    const { app, auth, service } = await setup();
    const response = await app.inject({
      url: "/v1/sessions/s/devtools/inspector.html",
      headers: auth,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("connect-src 'self' ws://");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(
      (await app.inject({ url: "/v1/sessions/other/devtools/inspector.html", headers: auth }))
        .statusCode,
    ).toBe(403);
    for (const asset of [
      "../json/list",
      "%2e%2e/json",
      "x/../../json",
      "x\\..\\json",
      "http://elsewhere",
    ]) {
      expect(() => devtoolsAssetUrl(service.getWsEndpoint(), asset)).toThrow();
    }
    expect(
      devtoolsAssetUrl(service.getWsEndpoint(), "entrypoints/inspector/inspector.js").pathname,
    ).toBe("/devtools/entrypoints/inspector/inspector.js");
  });
});
