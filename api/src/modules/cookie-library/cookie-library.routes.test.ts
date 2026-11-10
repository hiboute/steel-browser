import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CookieLibraryService,
  CookieSetConflictError,
} from "../../services/cookie-library.service.js";
import routes from "./cookie-library.routes.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});
async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cookie-http-"));
  const library = new CookieLibraryService(dir);
  await library.save({
    name: "login",
    cookies: [{ name: "sid", value: "private-cookie", domain: "example.com" }],
  });
  const audit = vi.fn(async () => {});
  library.audit = audit;
  const health = { check: vi.fn(async () => ({ skipped: true, reason: "pool_busy" })) };
  const app = Fastify();
  app.decorate("cookieLibrary", library);
  app.decorate("cookieHealth", health as never);
  await app.register(routes, { prefix: "/v1" });
  await app.ready();
  cleanup.push(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { app, library, audit, health };
}

describe("cookie library v2 HTTP", () => {
  it("persists settings, serializes safe summaries and audits changes", async () => {
    const { app, library, audit } = await setup();
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/cookie-library/login",
      headers: { "x-steel-client": "ui" },
      payload: {
        check: { url: "https://example.com/me", loggedInSelector: "#account", enabled: true },
        acl: { clients: ["mcp:me"] },
        writeBack: false,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      check: { enabled: true },
      writeBack: false,
      health: { status: "unknown" },
      hasPrevious: false,
    });
    expect(response.body).not.toContain("private-cookie");
    expect((await library.get("login")).acl).toEqual({ clients: ["mcp:me"] });
    expect(audit).toHaveBeenCalledWith(
      "cookieset.updated",
      expect.objectContaining({ client: "ui", subject: "login" }),
    );
  });
  it("rejects malformed check settings and protects denied reads, writes and deletes", async () => {
    const { app, library } = await setup();
    const invalid = await app.inject({
      method: "PATCH",
      url: "/v1/cookie-library/login",
      payload: { check: { url: "file:///etc/passwd" } },
    });
    expect(invalid.statusCode).toBe(400);
    const invalidPattern = await app.inject({
      method: "PATCH",
      url: "/v1/cookie-library/login",
      payload: { check: { url: "https://example.com", loggedOutUrlPattern: "[" } },
    });
    expect(invalidPattern.statusCode).toBe(400);
    await library.update("login", { acl: { clients: ["allowed"] } });
    for (const method of ["GET", "DELETE", "PATCH", "PUT"] as const) {
      const response = await app.inject({
        method,
        url: "/v1/cookie-library/login",
        ...(method === "PATCH"
          ? { payload: {} }
          : method === "PUT"
          ? { payload: { cookies: [] } }
          : {}),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe("cookie_set_denied");
    }
    expect((await app.inject("/v1/cookie-library")).json().sets).toEqual([]);
    expect(
      (
        await app.inject({
          url: "/v1/cookie-library/login",
          headers: { "x-steel-client": "allowed" },
        })
      ).statusCode,
    ).toBe(200);
  });
  it("returns explicit no-check, capacity and restore errors", async () => {
    const { app, health } = await setup();
    const busy = await app.inject({ method: "POST", url: "/v1/cookie-library/login/check" });
    expect(busy.statusCode).toBe(503);
    expect(busy.json().code).toBe("pool_busy");
    health.check.mockRejectedValueOnce(
      new CookieSetConflictError("No check configured", "no_check"),
    );
    expect(
      (await app.inject({ method: "POST", url: "/v1/cookie-library/login/check" })).json().code,
    ).toBe("no_check");
    const missing = await app.inject({
      method: "POST",
      url: "/v1/cookie-library/login/restore-previous",
    });
    expect(missing.statusCode).toBe(409);
    expect(missing.json().code).toBe("no_previous");
  });
  it("restores credentials while keeping response values private", async () => {
    const { app, library } = await setup();
    await library.writeBack("login", {
      cookies: [{ name: "sid", value: "new-secret", domain: "example.com" }],
    });
    const restored = await app.inject({
      method: "POST",
      url: "/v1/cookie-library/login/restore-previous",
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.body).not.toMatch(/private-cookie|new-secret/);
    expect((await library.get("login")).cookies[0].value).toBe("private-cookie");
  });
});
