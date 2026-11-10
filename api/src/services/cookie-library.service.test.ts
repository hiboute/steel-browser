import { mkdtemp, readFile } from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  CookieLibraryService,
  CookieSetNotFoundError,
  filterByDomains,
} from "./cookie-library.service.js";

const cookie = (name: string, domain: string, value = "v") => ({ name, value, domain, path: "/" });

async function tmp() {
  return mkdtemp(path.join(os.tmpdir(), "cookie-lib-"));
}

describe("CookieLibraryService", () => {
  it("saves, lists without values, and merges sets in order", async () => {
    const lib = new CookieLibraryService(await tmp());
    await lib.save({ name: "github", cookies: [cookie("sid", ".github.com", "a")] });
    await lib.save({
      name: "github-2",
      cookies: [cookie("sid", ".github.com", "b"), cookie("x", "example.com")],
      localStorage: { "https://github.com": { k: "1" } },
    });

    const list = await lib.list();
    expect(list.map((s) => s.name).sort()).toEqual(["github", "github-2"]);
    expect(list.find((s) => s.name === "github-2")).toMatchObject({
      cookieCount: 2,
      originCount: 1,
      domains: ["example.com", "github.com"],
    });
    expect(JSON.stringify(list)).not.toContain('"value"');

    const merged = await lib.resolve(["github", "github-2"]);
    expect(merged.cookies.find((c) => c.name === "sid")?.value).toBe("b");
    expect(merged.localStorage).toEqual({ "https://github.com": { k: "1" } });
  });

  it("encrypts files at rest when a key is set", async () => {
    const dir = await tmp();
    const lib = new CookieLibraryService(dir, "secret");
    await lib.save({ name: "bank", cookies: [cookie("token", "bank.example", "s3cr3t")] });

    const raw = await readFile(path.join(dir, "bank.json"), "utf8");
    expect(raw).not.toContain("s3cr3t");
    expect((await lib.get("bank")).cookies[0].value).toBe("s3cr3t");
    await expect(new CookieLibraryService(dir).get("bank")).rejects.toThrow(/encrypted/);
    await expect(new CookieLibraryService(dir, "wrong").get("bank")).rejects.toThrow();
  });

  it("rejects bad names and reports missing sets", async () => {
    const lib = new CookieLibraryService(await tmp());
    await expect(lib.save({ name: "../etc", cookies: [] })).rejects.toThrow(/names are/);
    await expect(lib.get("nope")).rejects.toBeInstanceOf(CookieSetNotFoundError);
  });

  it("filters cookies and origins by domain, subdomains included", () => {
    const picked = filterByDomains(
      {
        cookies: [cookie("a", ".accounts.google.com"), cookie("b", "example.com")],
        localStorage: { "https://mail.google.com": {}, "https://example.com": {} },
      },
      ["google.com"],
    );
    expect(picked.cookies.map((c) => c.name)).toEqual(["a"]);
    expect(Object.keys(picked.localStorage ?? {})).toEqual(["https://mail.google.com"]);
  });
});

describe("CookieLibraryService v2", () => {
  it("preserves settings and identity during imports and never leaks them through a summary", async () => {
    const lib = new CookieLibraryService(await tmp());
    await lib.save({
      name: "login",
      cookies: [cookie("sid", "example.com", "secret")],
      fingerprint: {
        userAgent: "private-agent",
        fingerprint: { secret: "private-fingerprint" } as never,
      },
    });
    await lib.update("login", {
      writeBack: false,
      check: { url: "https://example.com/me", enabled: true },
      acl: { clients: ["mcp:*"] },
    });
    await lib.save({ name: "login", cookies: [cookie("sid", "example.com", "new-secret")] });
    const saved = await lib.get("login");
    expect(saved.writeBack).toBe(false);
    expect(saved.check?.enabled).toBe(true);
    expect(saved.fingerprint?.userAgent).toBe("private-agent");
    const list = await lib.list();
    expect(list[0]).toMatchObject({ hasFingerprint: true, writeBack: false, hasPrevious: false });
    expect(JSON.stringify(list)).not.toMatch(/new-secret|private-agent|private-fingerprint/);
  });

  it("does not overwrite an existing file when its encryption key is unavailable", async () => {
    const dir = await tmp();
    const encrypted = new CookieLibraryService(dir, "right");
    await encrypted.save({ name: "login", cookies: [cookie("sid", "example.com", "saved")] });
    await expect(
      new CookieLibraryService(dir).save({ name: "login", cookies: [] }),
    ).rejects.toThrow("encrypted");
    expect((await encrypted.get("login")).cookies[0].value).toBe("saved");
  });

  it("merges refreshed cookies and storage under the original domains and supports rollback", async () => {
    const lib = new CookieLibraryService(await tmp(), "key");
    const old = cookie("sid", ".example.com", "old");
    await lib.save({
      name: "login",
      cookies: [old],
      localStorage: { "https://example.com": { old: "kept", changed: "before" } },
    });
    const result = await lib.writeBack("login", {
      cookies: [
        cookie("sid", ".example.com", "fresh"),
        cookie("other", "accounts.example.com"),
        cookie("evil", "notexample.com"),
      ],
      localStorage: {
        "https://example.com": { changed: "after" },
        "https://evil.com": { token: "no" },
      },
    });
    expect(result.updated).toBe(true);
    expect(result.set.cookies.map((c) => c.name)).toEqual(["sid", "other"]);
    expect(result.set.localStorage).toEqual({
      "https://example.com": { old: "kept", changed: "after" },
    });
    expect((await lib.list())[0].hasPrevious).toBe(true);
    expect(JSON.stringify(await lib.list())).not.toMatch(/fresh|before|after/);
    const restored = await lib.restorePrevious("login");
    expect(restored.cookies).toEqual([old]);
    expect(restored.previous?.cookies[0].value).toBe("fresh");
  });

  it("does not write back logged-out sessions or cookies outside the set's scope", async () => {
    const lib = new CookieLibraryService(await tmp());
    await lib.save({
      name: "login",
      cookies: [cookie("a", "example.com"), cookie("b", "example.com"), cookie("c", "example.com")],
    });
    await lib.update("login", { authCookies: ["a", "b", "c"] });
    const result = await lib.writeBack("login", {
      cookies: [cookie("a", "example.com", "changed")],
    });
    expect(result).toMatchObject({ updated: false, reason: "auth_cookies_missing" });
    expect((await lib.get("login")).cookies[0].value).toBe("v");
    await lib.update("login", { writeBack: false });
    expect((await lib.writeBack("login", { cookies: [] })).reason).toBe("disabled");
  });

  it("uses auth cookie expiry instead of unrelated early-expiring cookies", async () => {
    const lib = new CookieLibraryService(await tmp());
    await lib.save({
      name: "login",
      cookies: [
        { ...cookie("auth", "example.com"), httpOnly: true, expires: 2_000_000_000 },
        { ...cookie("analytics", "example.com"), expires: 1 },
      ],
    });
    const summary = (await lib.list())[0];
    expect(summary.expiresAt).toBe("1970-01-01T00:00:01.000Z");
    expect(summary.authExpiresAt).toBe(new Date(2_000_000_000_000).toISOString());
    expect(summary.health.status).not.toBe("expired");
  });

  it("enforces client patterns on reads and loading while allowing UI", async () => {
    const lib = new CookieLibraryService(await tmp());
    await lib.save({ name: "login", cookies: [cookie("auth", "example.com")] });
    await lib.update("login", { acl: { clients: ["mcp:a.*@example.com", "exact"] } });
    await expect(lib.resolve(["login"], "mcp:a.x@example.com")).resolves.toBeDefined();
    await expect(lib.resolve(["login"], "mcp:abx@example.com")).rejects.toThrow("denied");
    await expect(lib.assertAccess("login", "ui")).resolves.toBeDefined();
    expect(await lib.list("anonymous")).toEqual([]);
  });

  it("pins identity and egress with explicit caller settings and saved browsers taking precedence", async () => {
    const lib = new CookieLibraryService(await tmp());
    await lib.save({
      name: "login",
      cookies: [cookie("auth", "example.com", "set")],
      fingerprint: {
        userAgent: "pinned",
        timezone: "Europe/Paris",
        dimensions: { width: 800, height: 600 },
      },
      localStorage: { "https://example.com": { a: "1", b: "old" } },
    });
    await lib.update("login", { egress: "home" });
    const options = await lib.prepareSession(["login"], {
      userAgent: "caller",
      sessionContext: {
        cookies: [cookie("auth", "example.com", "own")],
        localStorage: { "https://example.com": { b: "new" } },
      },
    });
    expect(options).toMatchObject({
      userAgent: "caller",
      timezone: "Europe/Paris",
      egress: "home",
    });
    expect(options.sessionContext?.cookies?.[0].value).toBe("own");
    expect(options.sessionContext?.localStorage).toEqual({
      "https://example.com": { a: "1", b: "new" },
    });
    expect(
      await lib.prepareSession(["login"], { browserProfile: "saved", proxyUrl: "http://explicit" }),
    ).not.toHaveProperty("fingerprint");
    expect(
      (
        await lib.prepareSession(["login"], {
          browserProfile: "saved",
          proxyUrl: "http://explicit",
        })
      ).egress,
    ).toBeUndefined();
  });

  it("serializes concurrent usage and write-back without losing settings", async () => {
    const lib = new CookieLibraryService(await tmp());
    await lib.save({ name: "login", cookies: [cookie("auth", "example.com")] });
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => lib.recordUse(["login"], "ui", `s${i}`)),
    );
    await Promise.all([
      lib.update("login", { description: "keep this" }),
      lib.writeBack("login", { cookies: [cookie("auth", "example.com", "new")] }),
    ]);
    expect(await lib.get("login")).toMatchObject({
      useCount: 12,
      description: "keep this",
      cookies: [{ value: "new" }],
    });
  });
});
