import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CookieLibraryService } from "./cookie-library.service.js";
import {
  CookieHealthService,
  inCheckWindow,
  prepareCookieSession,
} from "./cookie-health.service.js";

async function setup() {
  const lib = new CookieLibraryService(await mkdtemp(path.join(os.tmpdir(), "cookie-health-")));
  await lib.save({
    name: "login",
    cookies: [{ name: "sid", domain: "example.com", value: "old", httpOnly: true }],
  });
  await lib.update("login", {
    check: { url: "https://example.com/me", loggedInSelector: "#account" },
  });
  const page = {
    goto: vi.fn(async () => ({ status: () => 200 })),
    url: () => "https://example.com/me",
    evaluate: vi.fn(async () => ({ loggedIn: true, loggedOut: false, text: true })),
  };
  const session = {
    id: "check-session",
    cdpService: {
      getAllPages: async () => [page],
      getBrowserState: async () => ({}),
      getCookies: async () => [
        { name: "sid", domain: "example.com", value: "new", httpOnly: true },
      ],
    },
  };
  const deps = {
    runJob: vi.fn(async (_kind, _options, fn) => fn(session)),
    notify: vi.fn(async () => {}),
    warn: vi.fn(),
  };
  const health = new CookieHealthService(lib, deps as never, {
    warnDays: 3,
    window: "",
    settleMs: 0,
  });
  return { lib, page, deps, health };
}

describe("CookieHealthService", () => {
  it("checks in a background session and refreshes only successful logins", async () => {
    const { health, lib, deps } = await setup();
    const result = await health.check("login");
    expect(result).toMatchObject({
      result: { ok: true, reason: "logged_in" },
      set: { health: { status: "ok", consecutiveFailures: 0 } },
    });
    expect(deps.runJob.mock.calls[0][0]).toBe("cookie-check");
    expect(deps.runJob.mock.calls[0][1]).toMatchObject({
      sessionOptions: { cookieSetWriteBack: false },
    });
    expect((await lib.get("login")).cookies[0].value).toBe("new");
  });
  it("records failures without copying logged-out cookies and notifies on state transitions", async () => {
    const { health, lib, page, deps } = await setup();
    await lib.recordHealth("login", {
      ok: true,
      reason: "logged_in",
      finalUrl: "https://example.com",
      durationMs: 1,
    });
    page.evaluate.mockResolvedValue({ loggedIn: false, loggedOut: false, text: true });
    expect(await health.check("login")).toMatchObject({
      result: { ok: false },
      set: { health: { consecutiveFailures: 1 } },
    });
    expect((await lib.get("login")).cookies[0].value).toBe("old");
    expect(deps.notify).toHaveBeenCalledWith(
      expect.objectContaining({ event: "cookieset.failing" }),
    );
    await health.check("login");
    expect(deps.notify).toHaveBeenCalledTimes(1);
    page.evaluate.mockResolvedValue({ loggedIn: true, loggedOut: false, text: true });
    await health.check("login");
    expect(deps.notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ event: "cookieset.recovered" }),
    );
  });
  it.each([
    ["/me$", false, "logged_out_url"],
    ["/login$", true, "logged_in"],
  ])("evaluates URL condition %s with bounded matching", async (pattern, ok, reason) => {
    const { health, lib } = await setup();
    await lib.update("login", {
      check: { url: "https://example.com/me", loggedOutUrlPattern: pattern },
    });
    expect(await health.check("login")).toMatchObject({ result: { ok, reason } });
  });
  it("fails a pathological URL condition while API timers remain responsive", async () => {
    const { health, lib, page } = await setup();
    await lib.update("login", {
      check: { url: "https://example.com/me", loggedOutUrlPattern: "(a+)+$" },
    });
    page.url = () => `https://example.com/${"a".repeat(30000)}!`;
    let settled = false;
    const running = health.check("login").finally(() => {
      settled = true;
    });
    const started = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(settled).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
    expect(await running).toMatchObject({
      result: { ok: false, reason: "Regular expression exceeded its execution limit" },
      set: { health: { status: "failing", consecutiveFailures: 1 } },
    });
    expect((await lib.get("login")).cookies[0].value).toBe("old");
  });
  it("leaves health untouched when capacity is unavailable", async () => {
    const { health, lib, deps } = await setup();
    deps.runJob.mockResolvedValue(undefined);
    expect(await health.check("login")).toEqual({ skipped: true, reason: "pool_busy" });
    expect((await lib.get("login")).health).toBeUndefined();
  });
  it("deduplicates simultaneous manual checks and enforces ACL before joining", async () => {
    const { health, lib, deps } = await setup();
    await lib.update("login", { acl: { clients: ["allowed"] } });
    await Promise.all([health.check("login", "allowed"), health.check("login", "allowed")]);
    expect(deps.runJob).toHaveBeenCalledTimes(1);
    await expect(health.check("login", "blocked")).rejects.toThrow("denied");
  });
  it("warns once per expiry and respects disabled checks and check windows", async () => {
    const { health, lib, deps } = await setup();
    await lib.save({
      name: "login",
      cookies: [
        { name: "sid", value: "secret", domain: "example.com", httpOnly: true, expires: 100 },
      ],
    });
    await lib.update("login", { check: { url: "https://example.com", enabled: false } });
    await health.tick();
    await health.tick();
    expect(deps.runJob).not.toHaveBeenCalled();
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect((await lib.get("login")).health?.warnedExpiry).toBe(new Date(100_000).toISOString());
    expect(inCheckWindow("23:00-02:00", new Date("2026-01-01T00:30:00Z"))).toBe(true);
    expect(inCheckWindow("23:00-02:00", new Date("2026-01-01T12:30:00Z"))).toBe(false);
    expect(() => inCheckWindow("25:00-12:00")).toThrow();
  });
  it("does not schedule further checks after shutdown", async () => {
    const { health, deps } = await setup();
    health.stop();
    await health.tick();
    expect(deps.runJob).not.toHaveBeenCalled();
    await expect(health.check("login")).rejects.toThrow("shutting down");
  });
});

describe("cookie identity with saved browsers", () => {
  it("uses the cookie fingerprint for a new profile, then the saved fingerprint thereafter", async () => {
    const { lib } = await setup();
    const profiles = await mkdtemp(path.join(os.tmpdir(), "cookie-profiles-"));
    await lib.save({
      name: "login",
      cookies: [{ name: "sid", domain: "example.com", value: "v" }],
      fingerprint: { userAgent: "cookie-agent", dimensions: { width: 900, height: 600 } },
    });
    const fresh = { credentials: {}, cookieSets: ["login"], browserProfile: "saved" };
    await prepareCookieSession(lib, fresh, profiles);
    expect(fresh).toMatchObject({
      browserProfile: "saved",
      userAgent: "cookie-agent",
      dimensions: { width: 900, height: 600 },
    });
    await mkdir(path.join(profiles, "saved"));
    const fingerprint = {
      fingerprint: {
        navigator: { userAgent: "profile-agent" },
        screen: { width: 1200, height: 800 },
      },
      headers: {},
    };
    await writeFile(
      path.join(profiles, "saved", "steel-fingerprint.json"),
      JSON.stringify(fingerprint),
    );
    const existing = { credentials: {}, cookieSets: ["login"], browserProfile: "saved" };
    await prepareCookieSession(lib, existing, profiles);
    expect(existing).toMatchObject({
      userAgent: "profile-agent",
      dimensions: { width: 1200, height: 800 },
      fingerprint,
    });
    const explicit = {
      credentials: {},
      cookieSets: ["login"],
      browserProfile: "saved",
      userAgent: "caller-agent",
      dimensions: { width: 700, height: 500 },
    };
    await prepareCookieSession(lib, explicit, profiles);
    expect(explicit).toMatchObject({
      userAgent: "caller-agent",
      dimensions: { width: 700, height: 500 },
    });
  });
});
