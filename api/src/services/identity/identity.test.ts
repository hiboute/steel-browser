import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PlatformStore } from "../platform/store.js";
import { IdentityService, contradictions } from "./identity.service.js";
import { applyMobile } from "./mobile.js";
import { classifyFriction, retryAfter } from "./friction.service.js";
import type { StartSessionOptions, Session } from "../session.service.js";

let dir: string, store: PlatformStore, service: IdentityService, version: string;
const base = (): StartSessionOptions => ({ credentials: undefined });
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "steel-identity-unit-"));
  store = new PlatformStore(dir, "test encryption key");
  version = "Chromium 149.0.7800.1";
  service = new IdentityService({
    store,
    getSession: () => {
      throw Error("no session");
    },
    getOptions: () => undefined,
    browserVersion: async () => version,
  });
});
afterEach(async () => {
  await service.close();
  await rm(dir, { recursive: true, force: true });
});

describe("versioned coherent identities", () => {
  it("migrates legacy manifests without changing their fingerprint and rejects future schema versions", async () => {
    await store.write("identity/profiles/saved.json", {
      schemaVersion: 1,
      name: "saved",
      settings: { userAgent: "Chrome/149.0.7800.1" },
      fingerprint: { sentinel: "preserved" },
    });
    const p = await service.profile("saved");
    expect(p).toMatchObject({
      schemaVersion: 2,
      settings: { compatibilityMode: "legacy" },
      fingerprint: { sentinel: "preserved" },
      migration: { from: 1 },
    });
    expect(
      (
        await new IdentityService({
          store,
          getSession: () => null as never,
          getOptions: () => undefined,
        }).profile("saved")
      ).fingerprint,
    ).toEqual(p.fingerprint);
    await store.write("identity/profiles/future.json", { schemaVersion: 99 });
    await expect(service.profile("future")).rejects.toMatchObject({
      code: "identity_schema_incompatible",
    });
  });
  it("requires compare-and-swap for concurrent edits and preserves history", async () => {
    await service.putProfile("work", { settings: { compatibilityMode: "native" } });
    const results = await Promise.allSettled([
      service.putProfile("work", {
        expectedRevision: 1,
        settings: { compatibilityMode: "native", timezone: "Europe/Paris" },
      }),
      service.putProfile("work", {
        expectedRevision: 1,
        settings: { compatibilityMode: "native", timezone: "Asia/Tokyo" },
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await service.profile("work")).revision).toBe(2);
    expect(await store.read("identity/history/work.1.json")).toMatchObject({ revision: 1 });
  });
  it("blocks incompatible browser majors until deliberate upgrade, then preserves identity fields", async () => {
    await service.putProfile("work", {
      settings: {
        compatibilityMode: "compatible",
        userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/149.0.7800.1",
        timezone: "Europe/Paris",
      },
    });
    version = "Chromium 150.0.8000.2";
    await expect(service.prepare({ ...base(), identityProfile: "work" })).rejects.toMatchObject({
      code: "identity_upgrade_required",
    });
    const migrated = await service.migrate("work", 1);
    expect(migrated.settings.userAgent).toContain("Chrome/150.0.8000.2");
    expect(migrated.settings.timezone).toBe("Europe/Paris");
    await service.prepare({ ...base(), identityProfile: "work" });
  });
  it("rejects explicit conflicts, impossible native overrides and unsupported mobile claims", async () => {
    await service.putProfile("work", {
      settings: { compatibilityMode: "compatible", timezone: "Europe/Paris" },
    });
    await expect(
      service.prepare({ ...base(), identityProfile: "work", timezone: "Asia/Tokyo" }),
    ).rejects.toMatchObject({ code: "identity_override_conflict" });
    await expect(
      service.putProfile("bad", { settings: { compatibilityMode: "native", userAgent: "custom" } }),
    ).rejects.toMatchObject({ code: "native_override_conflict" });
    expect(() =>
      applyMobile(
        { ...base(), mobileProfile: "android-compact", userAgent: "Safari iPhone" },
        version,
      ),
    ).toThrow(/Android/);
  });
  it("generates compatible UA and Client Hints using actual Chrome, with stable saved fingerprint after restart", async () => {
    await service.putProfile("account", {
      settings: { compatibilityMode: "compatible", dimensions: { width: 1024, height: 768 } },
      bindings: { browserProfile: "account" },
    });
    const options = { ...base(), browserProfile: "account" };
    await service.prepare(options);
    expect(options.identityProfile).toBe("account");
    expect(options.fingerprint?.fingerprint.navigator.userAgent).toContain("Chrome/149.0.7800.1");
    const fake = {
      id: "session",
      userAgent: options.fingerprint!.fingerprint.navigator.userAgent,
      cdpService: {
        getFingerprintData: () => options.fingerprint,
        getBrowserVersion: async () => version,
      },
    } as unknown as Session;
    const s2 = new IdentityService({
      store,
      getSession: () => fake,
      getOptions: () => options,
      browserVersion: async () => version,
    });
    await s2.started(fake);
    await s2.close();
    const s3 = new IdentityService({
      store: new PlatformStore(dir, "test encryption key"),
      getSession: () => fake,
      getOptions: () => options,
      browserVersion: async () => version,
    });
    const next = { ...base(), browserProfile: "account" };
    await s3.prepare(next);
    expect(next.fingerprint).toEqual(options.fingerprint);
    await s3.close();
  });
  it("serializes first identity materialization and rejects ambiguous bindings", async () => {
    await service.putProfile("shared", {
      settings: { compatibilityMode: "compatible" },
      bindings: { cookieSets: ["account"] },
    });
    const first: StartSessionOptions = { ...base(), identityProfile: "shared" },
      second: StartSessionOptions = { ...base(), identityProfile: "shared" };
    await Promise.all([service.prepare(first), service.prepare(second)]);
    expect(first.fingerprint).toEqual(second.fingerprint);
    await expect(
      service.putProfile("other", {
        settings: { compatibilityMode: "native" },
        bindings: { cookieSets: ["account"] },
      }),
    ).rejects.toMatchObject({ code: "identity_binding_conflict" });
  });
  it("does not rewrite parked launch identity during resume", async () => {
    const options = {
      ...base(),
      _resuming: true,
      identityProfile: "missing",
      fingerprint: { sentinel: true },
    } as unknown as StartSessionOptions;
    await service.prepare(options);
    expect(options.fingerprint).toEqual({ sentinel: true });
  });
  it("compares canonical timezone aliases without hiding explicit mismatches", () => {
    expect(contradictions({ timezone: "Asia/Kolkata" }, { timezone: "Asia/Calcutta" }, "Chrome/149"))
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ code: "timezone_mismatch" })]));
    expect(contradictions({ timezone: "Etc/UTC" }, { timezone: "UTC" }, "Chrome/149"))
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ code: "timezone_mismatch" })]));
    expect(contradictions({ timezone: "Europe/Paris" }, { timezone: "UTC" }, "Chrome/149"))
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "timezone_mismatch" })]));
    expect(contradictions({ timezone: "Europe/Paris" }, {}, "Chrome/149"))
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "timezone_mismatch" })]));
  });
  it("reports contradictory UA/platform/mobile and compares JS with collector headers", () => {
    const issues = contradictions(
      { userAgent: "Chrome/148.0.0.0 Windows" },
      {
        userAgent: "Chrome/149.0.0.0",
        clientHints: {
          mobile: true,
          platform: "Linux",
          highEntropy: { uaFullVersion: "147.0.0.0" },
        },
      },
      version,
      { "user-agent": "Different", "sec-ch-ua-mobile": "?0" },
    );
    expect(issues.map((i) => i.code)).toEqual(
      expect.arrayContaining([
        "browser_version_mismatch",
        "client_hints_version_mismatch",
        "mobile_mismatch",
        "platform_mismatch",
        "http_js_ua_mismatch",
        "http_js_mobile_mismatch",
      ]),
    );
  });
});

describe("site profiles and continuity", () => {
  it("validates exact origins, precedence and origin-scoped interaction", async () => {
    await expect(service.putSite("bad", { origin: "https://example.test/path" })).rejects.toThrow();
    await service.putSite("portal", {
      origin: "https://portal.test",
      settings: { compatibilityMode: "native" },
      permissions: ["notifications"],
      interaction: { frictionDetection: true, actionDelayMs: 50 },
    });
    const options = { ...base(), siteProfile: "portal" };
    await service.prepare(options);
    expect(options).toMatchObject({
      compatibilityMode: "native",
      skipFingerprintInjection: true,
      frictionDetection: true,
    });
    const s = new IdentityService({
      store,
      getSession: () => null as never,
      getOptions: () => options,
    });
    expect(await s.interactionForSession("s", "https://portal.test/path")).toEqual({
      frictionDetection: true,
      actionDelayMs: 50,
    });
    expect(await s.interactionForSession("s", "https://other.test")).toBeUndefined();
    await s.close();
  });
  it("detects IP/upstream rotation, requires a drift-bound token and persists confirmation across restart", async () => {
    let ip = "203.0.113.1",
      upstream = "https://user:password@proxy-a.test:443",
      healthy = true,
      probeRevision = 0;
    const options = {
      ...base(),
      identityProfile: "acct",
      egress: "home",
      continuityPolicy: "require-confirmation" as const,
    };
    await service.putProfile("acct", { settings: { compatibilityMode: "native", egress: "home" } });
    const deps = {
      store,
      getSession: () => null as never,
      getOptions: () => options,
      browserVersion: async () => version,
      egressProbe: async () => ({
        healthy,
        publicIp: healthy ? ip : null,
        country: "FR",
        checkedAt: new Date(++probeRevision * 1000).toISOString(),
        name: "home",
        label: `probe-${probeRevision}`,
      }),
      resolveEgress: async () => ({ proxyUrl: upstream }),
    };
    const s = new IdentityService(deps);
    const first = await s.sessionContinuity("s");
    expect(first.status).toBe("new");
    expect(JSON.stringify(first)).not.toContain(ip);
    expect(JSON.stringify(first)).not.toContain("password");
    const unchanged = await s.sessionContinuity("s");
    expect(unchanged.confirmationToken).toBe(first.confirmationToken);
    await s.confirmContinuity("s", first.confirmationToken);
    ip = "203.0.113.2";
    upstream = "https://proxy-b.test:443";
    await expect(s.prepare({ ...options })).rejects.toMatchObject({
      code: "continuity_confirmation_required",
    });
    const drift = await s.sessionContinuity("s");
    expect(drift.changes).toEqual(expect.arrayContaining(["publicIp", "upstream"]));
    await s.prepare({ ...options, continuityToken: drift.confirmationToken });
    ip = "203.0.113.3";
    await expect(s.confirmContinuity("s", drift.confirmationToken)).rejects.toMatchObject({
      code: "continuity_changed",
    });
    const current = await s.sessionContinuity("s");
    await s.confirmContinuity("s", current.confirmationToken);
    await s.close();
    const restarted = new IdentityService({
      ...deps,
      store: new PlatformStore(dir, "test encryption key"),
    });
    expect((await restarted.sessionContinuity("s")).status).toBe("stable");
    healthy = false;
    const unavailable = await restarted.sessionContinuity("s");
    expect(unavailable.status).toBe("unavailable");
    await expect(
      restarted.confirmContinuity("s", unavailable.confirmationToken),
    ).rejects.toMatchObject({ code: "continuity_unverified" });
    await restarted.close();
  });
});

describe("friction and mobile signals", () => {
  it("classifies bounded retry and avoids implicit retry", () => {
    const clear = { captcha: false, twoFactor: false, loginExpired: false };
    expect(classifyFriction(clear)).toBeUndefined();
    expect(classifyFriction({ ...clear, status: 429, retryAfter: "99999999" })).toMatchObject({
      kind: "throttled",
      retryAfterMs: 3_600_000,
    });
    expect(classifyFriction({ ...clear, twoFactor: true })).toMatchObject({
      kind: "two_factor",
      confidence: 0.9,
    });
    expect(classifyFriction({ ...clear, status: 403 })).toMatchObject({ kind: "access_denied" });
    expect(retryAfter("2")).toBe(2000);
    expect(retryAfter("nonsense")).toBe(30_000);
  });
  it("sets coherent Android mobile viewport/touch/CH and rejects impossible dimensions", () => {
    const options = {
      ...base(),
      compatibilityMode: "compatible" as const,
      mobileProfile: "android-landscape",
    };
    applyMobile(options, version);
    expect(options.dimensions).toEqual({ width: 873, height: 393 });
    expect(options.fingerprint?.fingerprint.navigator.userAgentData).toMatchObject({
      mobile: true,
      platform: "Android",
      uaFullVersion: "149.0.7800.1",
    });
    expect(() =>
      applyMobile(
        { ...base(), mobileProfile: "android-large", dimensions: { width: 1, height: 2 } },
        version,
      ),
    ).toThrow(/preset dimensions/);
  });
});
