import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { it, expect } from "vitest";
import { CookieLibraryService } from "../cookie-library.service.js";
import { prepareCookieSession } from "../cookie-health.service.js";
import { IdentityService } from "./identity.service.js";
import { PlatformStore } from "../platform/store.js";
import type { StartSessionOptions } from "../session.service.js";

it("native and migrated identities import login state without reviving an old saved-browser UA", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "steel-identity-cookie-"));
  const library = new CookieLibraryService(path.join(dir, "cookies"));
  const profiles = path.join(dir, "profiles");
  try {
    await mkdir(path.join(profiles, "saved"), { recursive: true });
    const old = {
      fingerprint: {
        navigator: { userAgent: "legacy-profile-agent" },
        screen: { width: 1200, height: 800 },
      },
      headers: {},
    };
    await writeFile(path.join(profiles, "saved", "steel-fingerprint.json"), JSON.stringify(old));
    await library.save({
      name: "login",
      cookies: [{ name: "sid", value: "private-cookie", domain: "example.com" }],
      fingerprint: {
        userAgent: "legacy-cookie-agent",
        timezone: "Asia/Tokyo",
        locale: "ja-JP",
        dimensions: { width: 900, height: 600 },
      },
    });
    await library.update("login", { egress: "home" });
    const native: StartSessionOptions = {
      credentials: undefined,
      compatibilityMode: "native",
      skipFingerprintInjection: true,
      cookieSets: ["login"],
      browserProfile: "saved",
    };
    await prepareCookieSession(library, native, profiles);
    expect(native.userAgent).toBeUndefined();
    expect(native.fingerprint).toBeUndefined();
    expect(native.timezone).toBeUndefined();
    expect(native.userPreferences).toBeUndefined();
    expect(native.sessionContext?.cookies?.[0].value).toBe("private-cookie");
    expect(native.egress).toBe("home");
    const fingerprint = {
      ...old,
      fingerprint: { ...old.fingerprint, navigator: { userAgent: "migrated-agent" } },
    };
    const migrated: StartSessionOptions = {
      credentials: undefined,
      identityProfile: "work",
      compatibilityMode: "compatible",
      fingerprint: fingerprint as never,
      cookieSets: ["login"],
      browserProfile: "saved",
    };
    await prepareCookieSession(library, migrated, profiles);
    expect(migrated.userAgent).toBeUndefined();
    expect(migrated.fingerprint).toEqual(fingerprint);
    expect(migrated.sessionContext?.cookies?.[0].value).toBe("private-cookie");
    const legacy: StartSessionOptions = {
      credentials: undefined,
      cookieSets: ["login"],
      browserProfile: "saved",
    };
    await prepareCookieSession(library, legacy, profiles);
    expect(legacy.userAgent).toBe("legacy-profile-agent");
    expect(legacy.fingerprint).toEqual(old);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("continuity observes and freezes cookie-set egress before the session resolver can select another upstream", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "steel-identity-egress-"));
  const calls: string[] = [];
  const service = new IdentityService({
    store: new PlatformStore(dir),
    getSession: () => null as never,
    getOptions: () => undefined,
    browserVersion: async () => "Chrome/149.0.0.1",
    cookieEgress: async () => "home",
    resolveEgress: async (name) => {
      calls.push(name);
      return { proxyUrl: "https://user:secret@selected.test:443" };
    },
    egressProbe: async (name, url) => {
      expect(name).toBe("home");
      expect(url).toBe("https://user:secret@selected.test:443");
      return { healthy: true, publicIp: "203.0.113.1", country: "FR" };
    },
  });
  try {
    const options: StartSessionOptions = { credentials: undefined, cookieSets: ["account"] };
    await service.prepare(options);
    expect(options).toMatchObject({
      egress: "home",
      proxyUrl: "https://user:secret@selected.test:443",
      proxyLabel: "home",
    });
    expect(calls).toEqual(["home"]);
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});
