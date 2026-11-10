import { FingerprintGenerator } from "fingerprint-generator";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Session, StartSessionOptions } from "../session.service.js";
import type { PlatformStore } from "../platform/store.js";
import { getChromeExecutablePath } from "../../utils/browser.js";
import { activePage, bounded } from "../handoff/agent-feature-utils.js";
import { IdentityCollector, observe, fixtureChecks, type Check } from "./collector.js";
import { applyMobile, mobileProfiles } from "./mobile.js";
import {
  IdentityError,
  Name,
  ProfileInput,
  SiteInput,
  Settings,
  major,
  now,
  safeOrigin,
  type IdentityManifest,
  type IdentitySettings,
  type SiteProfile,
} from "./types.js";

export interface IdentityDependencies {
  store: PlatformStore;
  getSession: (id: string) => Session;
  getOptions: (id: string) => StartSessionOptions | undefined;
  browserVersion?: () => Promise<string>;
  egressProbe?: (
    name: string,
    proxyUrl?: string,
  ) => Promise<{ healthy: boolean | null; publicIp: string | null; country: string | null }>;
  cookieEgress?: (names: string[], client?: string) => Promise<string | undefined>;
  resolveEgress?: (name: string) => Promise<{ proxyUrl?: string }>;
  publish?: (type: string, data: unknown, sessionId?: string) => void;
}
export interface Issue {
  code: string;
  severity: "warning" | "error";
  message: string;
}
export interface IdentityReport {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  at: string;
  browserVersion: string;
  requested: Record<string, unknown>;
  observed: {
    status: "measured" | "unavailable";
    values?: Awaited<ReturnType<typeof observe>>;
    reason?: string;
  };
  collector: Awaited<ReturnType<IdentityCollector["headers"]>>;
  issues: Issue[];
  patches: unknown;
  limits: string[];
}
export interface LabReport {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  at: string;
  browserVersion: string;
  mode: string;
  mobileProfile?: string;
  runtime: string;
  checks: Check[];
  passed: boolean;
  baselineId?: string;
  regressions: string[];
}
interface RouteObservation {
  egress: string;
  upstream?: string;
  publicIp: string | null;
  country: string | null;
  healthy: boolean | null;
  at: string;
}
interface Continuity {
  key: string;
  previous?: RouteObservation;
  current: RouteObservation;
  changes: string[];
  status: "new" | "stable" | "drift" | "unavailable";
  token: string;
}
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function alignFingerprint(
  fp: NonNullable<StartSessionOptions["fingerprint"]>,
  version: string,
  locale?: string,
) {
  const full = version.match(/\d+\.\d+\.\d+\.\d+/)?.[0];
  if (!full)
    throw new IdentityError(
      "browser_version_unavailable",
      "A measured Chromium version is required",
      503,
    );
  const n = fp.fingerprint.navigator;
  const mobile = /Android/.test(n.userAgent);
  Object.assign(n.userAgentData, {
    platform: mobile ? "Android" : "Linux",
    mobile,
    brands: [{ brand: "Chromium", version: String(major(version)) }],
    fullVersionList: [{ brand: "Chromium", version: full }],
    uaFullVersion: full,
    architecture: mobile ? "arm" : process.arch === "arm64" ? "arm" : "x86",
    bitness: "64",
    model: mobile ? n.userAgentData.model ?? "" : "",
    platformVersion: n.userAgentData.platformVersion ?? "",
  });
  for (const key of Object.keys(fp.headers)) if (/^sec-ch-ua/i.test(key)) delete fp.headers[key];
  fp.headers["user-agent"] = n.userAgent;
  if (locale) fp.headers["accept-language"] = locale;
}

const keyFor = (options: StartSessionOptions) =>
  options.browserProfile
    ? `browser-${options.browserProfile}`
    : options.cookieSets?.length
    ? `cookies-${hash([...options.cookieSets].sort().join(",")).slice(0, 24)}`
    : options.identityProfile
    ? `identity-${options.identityProfile}`
    : undefined;
export function contradictions(
  requested: Record<string, any>,
  observed: any,
  browserVersion: string,
  headers?: Record<string, string>,
): Issue[] {
  const issues: Issue[] = [];
  const add = (code: string, message: string, severity: "warning" | "error" = "warning") =>
    issues.push({ code, message, severity });
  const ua = requested.userAgent ?? observed?.userAgent;
  const runtime = major(browserVersion);
  if (major(ua) !== undefined && runtime !== undefined && major(ua) !== runtime)
    add(
      "browser_version_mismatch",
      "Declared UA major differs from the actual browser major",
      "error",
    );
  if (
    observed?.clientHints?.highEntropy?.uaFullVersion &&
    major(observed.clientHints.highEntropy.uaFullVersion) !== runtime
  )
    add(
      "client_hints_version_mismatch",
      "Client Hints version differs from the actual browser major",
      "error",
    );
  if (ua && observed?.clientHints) {
    const mobile = /Android|Mobile|iPhone/i.test(ua);
    if (mobile !== observed.clientHints.mobile)
      add("mobile_mismatch", "UA mobile claim differs from Client Hints", "error");
    const platform = /Android/.test(ua)
      ? "Android"
      : /Windows/.test(ua)
      ? "Windows"
      : /iPhone|iPad/.test(ua)
      ? "iOS"
      : /Macintosh/.test(ua)
      ? "macOS"
      : /Linux/.test(ua)
      ? "Linux"
      : undefined;
    if (platform && platform !== observed.clientHints.platform)
      add("platform_mismatch", "UA platform differs from Client Hints platform", "error");
  }
  if (requested.timezone && observed?.timezone !== requested.timezone)
    add("timezone_mismatch", "Requested and measured timezones differ");
  if (
    requested.locale &&
    observed?.language &&
    !String(requested.locale).split(",").includes(observed.language)
  )
    add("locale_mismatch", "Requested locale differs from navigator.language");
  if (
    headers?.["user-agent"] &&
    observed?.userAgent &&
    headers["user-agent"] !== observed.userAgent
  )
    add("http_js_ua_mismatch", "Owned collector HTTP User-Agent differs from JavaScript", "error");
  if (
    headers?.["sec-ch-ua-mobile"] &&
    observed?.clientHints &&
    headers["sec-ch-ua-mobile"] !== (observed.clientHints.mobile ? "?1" : "?0")
  )
    add("http_js_mobile_mismatch", "HTTP and JavaScript mobile claims differ", "error");
  return issues;
}
export class IdentityService {
  readonly collector = new IdentityCollector();
  private locks = new Map<string, Promise<unknown>>();
  private continuity = new Map<string, Continuity>();
  private labBusy = new Set<string>();
  constructor(private d: IdentityDependencies) {}
  private async serial<T>(key: string, action: () => Promise<T>): Promise<T> {
    const job = (this.locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(action);
    this.locks.set(key, job);
    try {
      return await job;
    } finally {
      if (this.locks.get(key) === job) this.locks.delete(key);
    }
  }
  async browserVersion() {
    if (this.d.browserVersion) return this.d.browserVersion();
    const r = await promisify(execFile)(getChromeExecutablePath(), ["--version"], {
      timeout: 4000,
      maxBuffer: 4096,
    });
    return r.stdout.trim();
  }
  private file(kind: string, name: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(name))
      throw new IdentityError("invalid_name", "Invalid profile name");
    return `identity/${kind}/${name}.json`;
  }
  async profile(name: string): Promise<IdentityManifest> {
    const raw = await this.d.store.read<any>(this.file("profiles", name));
    if (!raw) throw new IdentityError("identity_not_found", "Identity profile not found", 404);
    if (raw.schemaVersion === 2) {
      Settings.parse(raw.settings);
      return raw;
    }
    if (raw.schemaVersion === 1 || raw.version === 1) {
      const migrated: IdentityManifest = {
        schemaVersion: 2,
        name,
        revision: raw.revision ?? 1,
        createdAt: raw.createdAt ?? now(),
        updatedAt: now(),
        browserVersion: raw.browserVersion,
        settings: Settings.parse({
          ...raw.settings,
          compatibilityMode: raw.settings?.compatibilityMode ?? "legacy",
        }),
        fingerprint: raw.fingerprint,
        bindings: raw.bindings,
        migration: {
          from: 1,
          at: now(),
          reason: "Read legacy manifest; retained fingerprint and legacy patch behavior",
        },
      };
      await this.d.store.write(this.file("profiles", name), migrated);
      return migrated;
    }
    throw new IdentityError(
      "identity_schema_incompatible",
      "Identity manifest version is unsupported",
      409,
    );
  }
  async listProfiles() {
    const result: IdentityManifest[] = [];
    for (const f of (await this.d.store.list("identity/profiles"))
      .filter((f) => f.endsWith(".json"))
      .slice(0, 1000))
      result.push(await this.profile(f.slice(0, -5)));
    return result.map((p) => this.summary(p));
  }
  summary(p: IdentityManifest) {
    const { fingerprint, ...rest } = p;
    return { ...rest, hasFingerprint: !!fingerprint };
  }
  async putProfile(name: string, raw: unknown) {
    const input = ProfileInput.parse(raw);
    return this.serial("profiles", async () => {
      const old = await this.profile(name).catch((e) => {
        if (e.code !== "identity_not_found") throw e;
        return undefined;
      });
      if (old && input.expectedRevision !== old.revision)
        throw new IdentityError(
          "revision_conflict",
          "Pass the current expectedRevision to update an identity",
          409,
        );
      for (const other of await this.listProfiles()) {
        if (other.name === name) continue;
        if (
          (input.bindings?.browserProfile &&
            input.bindings.browserProfile === other.bindings?.browserProfile) ||
          input.bindings?.cookieSets?.some((set) => other.bindings?.cookieSets?.includes(set))
        ) {
          throw new IdentityError(
            "identity_binding_conflict",
            "A saved browser or cookie set is already bound to another identity",
            409,
          );
        }
      }
      this.validateSettings(input.settings);
      const version = await this.browserVersion();
      const p: IdentityManifest = {
        schemaVersion: 2,
        name: Name.parse(name),
        revision: (old?.revision ?? 0) + 1,
        createdAt: old?.createdAt ?? now(),
        updatedAt: now(),
        browserVersion: version,
        settings: input.settings,
        bindings: input.bindings,
        fingerprint: old && equal(old.settings, input.settings) ? old.fingerprint : undefined,
      };
      if (old) await this.d.store.write(this.file("history", `${name}.${old.revision}`), old);
      await this.d.store.write(this.file("profiles", name), p);
      return this.summary(p);
    });
  }
  private validateSettings(s: Partial<IdentitySettings>) {
    if (s.compatibilityMode === "native" && (s.userAgent || s.mobileProfile))
      throw new IdentityError(
        "native_override_conflict",
        "Native mode cannot override browser identity or emulate a mobile device",
      );
    if (s.mobileProfile && !mobileProfiles.some((p) => p.id === s.mobileProfile))
      throw new IdentityError("unknown_mobile_profile", "Unknown mobile profile");
  }
  async deleteProfile(name: string) {
    await this.serial("profiles", () => this.d.store.remove(this.file("profiles", name)));
  }
  async migrate(name: string, expectedRevision: number, mode?: "native" | "compatible" | "legacy") {
    return this.serial("profiles", async () => {
      const p = await this.profile(name);
      if (p.revision !== expectedRevision)
        throw new IdentityError(
          "revision_conflict",
          "Identity changed since migration was proposed",
          409,
        );
      const version = await this.browserVersion(),
        full = version.match(/\d+\.\d+\.\d+\.\d+/)?.[0];
      if (!full)
        throw new IdentityError(
          "browser_version_unavailable",
          "Cannot migrate without a measured browser version",
          503,
        );
      await this.d.store.write(this.file("history", `${name}.${p.revision}`), p);
      p.settings.compatibilityMode = mode ?? p.settings.compatibilityMode;
      const updateUA = (v: string) =>
        v.replace(/(Chrome|Chromium|HeadlessChrome)\/\d+(?:\.\d+)*/g, `$1/${full}`);
      if (p.settings.compatibilityMode === "native") {
        delete p.settings.userAgent;
        delete p.settings.mobileProfile;
        delete p.fingerprint;
      } else {
        if (p.settings.userAgent) p.settings.userAgent = updateUA(p.settings.userAgent);
        if (p.fingerprint) {
          const n = p.fingerprint.fingerprint.navigator;
          n.userAgent = updateUA(n.userAgent);
          p.fingerprint.headers["user-agent"] = n.userAgent;
          const ch = n.userAgentData;
          ch.uaFullVersion = full;
          for (const b of ch.brands ?? [])
            if (/chrom/i.test(b.brand)) b.version = String(major(version));
          for (const b of ch.fullVersionList ?? []) if (/chrom/i.test(b.brand)) b.version = full;
        }
      }
      if (p.fingerprint && p.settings.compatibilityMode === "compatible")
        alignFingerprint(p.fingerprint, version, p.settings.locale);
      p.migration = { from: p.revision, at: now(), reason: `Explicit upgrade to ${version}` };
      p.revision++;
      p.browserVersion = version;
      p.updatedAt = now();
      await this.d.store.write(this.file("profiles", name), p);
      return this.summary(p);
    });
  }
  async captureProfile(name: string, id: string, expectedRevision?: number) {
    const session = this.d.getSession(id),
      options = this.d.getOptions(id) ?? ({ credentials: {} } as StartSessionOptions);
    const result = await this.putProfile(name, {
      expectedRevision,
      settings: {
        compatibilityMode: options.compatibilityMode ?? "legacy",
        userAgent: options.compatibilityMode === "native" ? undefined : session.userAgent,
        timezone: options.timezone,
        locale: options.userPreferences?.intl?.accept_languages,
        dimensions: options.dimensions,
        headless: options.headless,
        mobileProfile: options.mobileProfile,
        egress: options.egress,
      },
      bindings: { browserProfile: options.browserProfile, cookieSets: options.cookieSets },
    });
    await this.serial("profiles", async () => {
      const p = await this.profile(name);
      if (p.revision !== result.revision)
        throw new IdentityError("revision_conflict", "Identity changed during capture", 409);
      p.fingerprint = session.cdpService.getFingerprintData() ?? undefined;
      p.browserVersion = await session.cdpService.getBrowserVersion();
      await this.d.store.write(this.file("profiles", name), p);
    });
    return this.summary(await this.profile(name));
  }
  async site(name: string): Promise<SiteProfile> {
    const p = await this.d.store.read<SiteProfile>(this.file("sites", name));
    if (!p) throw new IdentityError("site_profile_not_found", "Site profile not found", 404);
    return p;
  }
  async listSites() {
    return Promise.all(
      (await this.d.store.list("identity/sites"))
        .filter((f) => f.endsWith(".json"))
        .slice(0, 1000)
        .map((f) => this.site(f.slice(0, -5))),
    );
  }
  async putSite(name: string, raw: unknown) {
    const input = SiteInput.parse(raw);
    return this.serial(`site:${name}`, async () => {
      const old = await this.site(name).catch((e) => {
        if (e.code !== "site_profile_not_found") throw e;
        return undefined;
      });
      if (old && old.revision !== input.expectedRevision)
        throw new IdentityError(
          "revision_conflict",
          "Pass expectedRevision to update site profile",
          409,
        );
      if (input.identityProfile) await this.profile(input.identityProfile);
      this.validateSettings(input.settings ?? {});
      const p: SiteProfile = {
        ...input,
        name: Name.parse(name),
        revision: (old?.revision ?? 0) + 1,
        createdAt: old?.createdAt ?? now(),
        updatedAt: now(),
      };
      delete p.expectedRevision;
      if (old) await this.d.store.write(this.file("site-history", `${name}.${old.revision}`), old);
      await this.d.store.write(this.file("sites", name), p);
      return p;
    });
  }
  async interactionForSession(id: string, url: string) {
    const options = this.d.getOptions(id);
    if (!options?.siteProfile) return;
    const site = await this.site(options.siteProfile);
    if (safeOrigin(url) !== site.origin) return;
    return site.interaction;
  }
  async deleteSite(name: string) {
    await this.serial(`site:${name}`, () => this.d.store.remove(this.file("sites", name)));
  }
  async markSiteSuccessful(name: string, id: string) {
    return this.serial(`site:${name}`, async () => {
      const p = await this.site(name);
      const page = await activePage(this.d.getSession(id));
      if (safeOrigin(page?.url() ?? "") !== p.origin)
        throw new IdentityError(
          "site_origin_mismatch",
          "Current page is outside this site profile",
          409,
        );
      p.lastSuccessfulAt = now();
      await this.d.store.write(this.file("sites", name), p);
      return p;
    });
  }
  private merge(options: StartSessionOptions, settings: Partial<IdentitySettings>, source: string) {
    for (const [key, value] of Object.entries(settings)) {
      if (value === undefined) continue;
      if (key === "locale") {
        const current = options.userPreferences?.intl?.accept_languages;
        if (current !== undefined && current !== value)
          throw new IdentityError(
            "identity_override_conflict",
            `${source} locale conflicts with explicit options`,
            409,
          );
        options.userPreferences = {
          ...options.userPreferences,
          intl: { ...options.userPreferences?.intl, accept_languages: value },
        };
        continue;
      }
      const current = (options as any)[key];
      if (current !== undefined && !equal(current, value))
        throw new IdentityError(
          "identity_override_conflict",
          `${source} ${key} conflicts with explicit options`,
          409,
        );
      (options as any)[key] = value;
    }
  }
  async prepare(options: StartSessionOptions) {
    if (options._resuming) return;
    let profileRevision: number | undefined;
    if (options.siteProfile) {
      const site = await this.site(options.siteProfile);
      if (
        options.identityProfile &&
        site.identityProfile &&
        site.identityProfile !== options.identityProfile
      )
        throw new IdentityError(
          "site_identity_conflict",
          "Site and explicit identity profiles differ",
          409,
        );
      options.identityProfile ??= site.identityProfile;
      this.merge(options, site.settings ?? {}, "Site profile");
      if (options.extensions && !equal(options.extensions, site.extensions))
        throw new IdentityError(
          "site_extensions_conflict",
          "Site extensions conflict with explicit extensions",
          409,
        );
      if (site.extensions.length) options.extensions = site.extensions;
      options.frictionDetection ??= site.interaction.frictionDetection;
    }
    if (!options.identityProfile) {
      const matches = (await this.listProfiles()).filter(
        (p) =>
          (options.browserProfile && p.bindings?.browserProfile === options.browserProfile) ||
          options.cookieSets?.some((name) => p.bindings?.cookieSets?.includes(name)),
      );
      if (matches.length > 1)
        throw new IdentityError(
          "identity_binding_conflict",
          "Requested browser/cookie sets have different identity bindings; choose a single identity explicitly",
          409,
        );
      if (matches[0]) options.identityProfile = matches[0].name;
    }
    const version = await this.browserVersion();
    if (options.identityProfile) {
      const p = await this.profile(options.identityProfile);
      profileRevision = p.revision;
      if (p.browserVersion && major(p.browserVersion) !== major(version))
        throw new IdentityError(
          "identity_upgrade_required",
          "Browser major changed; explicitly migrate this identity before launch",
          409,
          { profile: p.name, from: p.browserVersion, to: version },
        );
      this.merge(options, p.settings, "Identity profile");
      if (options.fingerprint && p.fingerprint && !equal(options.fingerprint, p.fingerprint))
        throw new IdentityError(
          "fingerprint_conflict",
          "Explicit fingerprint differs from saved identity",
          409,
        );
      options.fingerprint ??= p.fingerprint;
    }
    this.validateSettings({
      compatibilityMode: options.compatibilityMode,
      userAgent: options.userAgent,
      mobileProfile: options.mobileProfile,
    });
    if (options.compatibilityMode === "native") {
      options.skipFingerprintInjection = true;
      options.fingerprint = undefined;
    }
    if (options.mobileProfile) applyMobile(options, version);
    else if (options.compatibilityMode === "compatible" && !options.fingerprint) {
      if (options.userAgent && !/Linux/.test(options.userAgent))
        throw new IdentityError(
          "unsupported_platform_claim",
          "Desktop compatible mode currently supports the Linux Chromium runtime; use a real worker for another OS",
        );
      const fp = new FingerprintGenerator({
        devices: ["desktop"],
        operatingSystems: ["linux"],
        browsers: [{ name: "chrome" }],
        locales: [options.userPreferences?.intl?.accept_languages?.split(",")[0] ?? "en-US"],
      }).getFingerprint();
      const full = version.match(/\d+\.\d+\.\d+\.\d+/)?.[0];
      if (!full)
        throw new IdentityError(
          "browser_version_unavailable",
          "Compatible mode requires a measured Chromium version",
          503,
        );
      fp.fingerprint.navigator.userAgent =
        options.userAgent ??
        fp.fingerprint.navigator.userAgent.replace(/Chrome\/\d+(?:\.\d+)*/g, `Chrome/${full}`);
      const hints = fp.fingerprint.navigator.userAgentData;
      hints.uaFullVersion = full;
      for (const b of hints.brands ?? [])
        if (/chrom/i.test(b.brand)) b.version = String(major(version));
      for (const b of hints.fullVersionList ?? []) if (/chrom/i.test(b.brand)) b.version = full;
      alignFingerprint(fp, version, options.userPreferences?.intl?.accept_languages);
      if (options.dimensions)
        Object.assign(fp.fingerprint.screen, {
          ...options.dimensions,
          availWidth: options.dimensions.width,
          availHeight: options.dimensions.height,
          innerWidth: options.dimensions.width,
          innerHeight: options.dimensions.height,
          outerWidth: options.dimensions.width,
          outerHeight: options.dimensions.height,
        });
      options.fingerprint = fp;
    }
    if (options.identityProfile && options.fingerprint && options.compatibilityMode !== "native") {
      await this.serial("profiles", async () => {
        const p = await this.profile(options.identityProfile!);
        if (p.revision !== profileRevision)
          throw new IdentityError(
            "revision_conflict",
            "Identity changed while launch was being prepared",
            409,
          );
        if (p.fingerprint) options.fingerprint = p.fingerprint;
        else {
          p.fingerprint = options.fingerprint;
          p.updatedAt = now();
          await this.d.store.write(this.file("profiles", p.name), p);
        }
      });
    }
    const issues = contradictions({ userAgent: options.userAgent }, undefined, version);
    if (issues.some((i) => i.severity === "error") && options.compatibilityMode === "compatible")
      throw new IdentityError("identity_contradiction", issues[0].message, 409);
    if (!options.egress && !options.proxyUrl && options.cookieSets?.length)
      options.egress = await this.d.cookieEgress?.(options.cookieSets, options.client);
    if (keyFor(options)) {
      const drift = await this.checkContinuity(options);
      if (
        options.continuityPolicy === "require-confirmation" &&
        ["drift", "unavailable"].includes(drift.status) &&
        options.continuityToken !== drift.token
      )
        throw new IdentityError(
          "continuity_confirmation_required",
          "Route changed or cannot be verified; inspect continuity and confirm this exact observation",
          409,
          this.publicContinuity(drift),
        );
    }
  }
  async started(session: Session) {
    const o = this.d.getOptions(session.id);
    if (!o) return;
    if (o.identityProfile) {
      await this.serial("profiles", async () => {
        const p = await this.profile(o.identityProfile!);
        if (!p.fingerprint && p.settings.compatibilityMode !== "native") {
          p.fingerprint = session.cdpService.getFingerprintData() ?? undefined;
          p.browserVersion = await session.cdpService.getBrowserVersion();
          p.updatedAt = now();
          await this.d.store.write(this.file("profiles", p.name), p);
        }
      });
    }
    if (o.siteProfile) {
      const p = await this.site(o.siteProfile);
      await session.cdpService
        .getBrowserInstance()
        ?.defaultBrowserContext()
        .overridePermissions(p.origin, p.permissions as any);
    }
    if (!o.identityProfile && (o.browserProfile || o.cookieSets?.length)) {
      const name = (
        o.browserProfile
          ? `browser-${o.browserProfile}`
          : `cookies-${hash([...o.cookieSets!].sort().join(",")).slice(0, 24)}`
      ).slice(0, 64);
      await this.captureProfile(name, session.id).catch((e) => {
        if (e.code !== "revision_conflict") throw e;
      });
    }
    if (keyFor(o)) {
      const drift = await this.checkContinuity(o);
      this.continuity.set(session.id, drift);
      this.d.publish?.("identity.continuity", this.publicContinuity(drift), session.id);
    }
  }
  async inspect(id: string): Promise<IdentityReport> {
    const session = this.d.getSession(id),
      options = this.d.getOptions(id);
    const browser = session.cdpService.getBrowserInstance();
    if (!browser)
      throw new IdentityError("browser_unavailable", "Session has no live browser", 409);
    const browserVersion = await session.cdpService.getBrowserVersion();
    let observed: IdentityReport["observed"];
    try {
      observed = {
        status: "measured",
        values: await bounded(observe((await activePage(session))!), 5000),
      };
    } catch {
      observed = { status: "unavailable", reason: "Active page could not be observed" };
    }
    const collector = await this.collector.headers(browser);
    const requested = {
      identityProfile: options?.identityProfile,
      compatibilityMode: options?.compatibilityMode ?? "legacy",
      userAgent: options?.userAgent,
      timezone: options?.timezone,
      locale: options?.userPreferences?.intl?.accept_languages,
      dimensions: options?.dimensions,
      mobileProfile: options?.mobileProfile,
    };
    const report: IdentityReport = {
      schemaVersion: 1,
      id: randomUUID(),
      sessionId: id,
      at: now(),
      browserVersion,
      requested,
      observed,
      collector,
      issues: contradictions(
        requested,
        observed.values,
        browserVersion,
        "headers" in collector ? collector.headers : undefined,
      ),
      patches: session.cdpService.getCompatibilityState(),
      limits: [
        "Measurements reflect this browser and page at observation time",
        "Fonts use bounded canvas metric comparisons; equivalent fonts may be indistinguishable",
        "HTTP collector uses configured STEEL_DIAGNOSTICS_COLLECTOR or owned loopback; unavailable routes are reported",
        "GPU/codec/device availability is not proof of physical hardware",
        "No guarantee of site acceptance or undetectability",
      ],
    };
    await this.d.store.write(`identity/reports/${id}.json`, report);
    await this.prune("identity/reports", 1000);
    return report;
  }
  async lab(id: string, baselineId?: string): Promise<LabReport> {
    if (this.labBusy.has(id))
      throw new IdentityError("lab_busy", "A compatibility run is already active", 409);
    this.labBusy.add(id);
    let page: Awaited<ReturnType<IdentityCollector["open"]>> | undefined;
    try {
      const session = this.d.getSession(id),
        browser = session.cdpService.getBrowserInstance();
      if (!browser)
        throw new IdentityError("browser_unavailable", "Session has no live browser", 409);
      let checks: Check[];
      try {
        page = await this.collector.open(browser);
        checks = await bounded(fixtureChecks(page), 15_000);
      } catch {
        checks = [
          {
            name: "fixture-runtime",
            status: "untested",
            detail: "Owned fixtures were unavailable or exceeded their deadline",
          },
        ];
      }
      const options = this.d.getOptions(id);
      const previous = baselineId ? await this.labReport(baselineId) : undefined;
      const regressions = checks
        .filter(
          (c) =>
            c.status === "fail" &&
            previous?.checks.some((p) => p.name === c.name && p.status === "pass"),
        )
        .map((c) => c.name);
      const report: LabReport = {
        schemaVersion: 1,
        id: randomUUID(),
        sessionId: id,
        at: now(),
        browserVersion: await session.cdpService.getBrowserVersion(),
        mode: session.cdpService.getCompatibilityState().mode,
        mobileProfile: options?.mobileProfile,
        runtime: options?.headless === false ? "headed-host-dependent" : "headless",
        checks,
        passed: checks.some((c) => c.status === "pass") && !checks.some((c) => c.status === "fail"),
        baselineId,
        regressions,
      };
      await this.d.store.write(`identity/lab/${report.id}.json`, report);
      await this.prune("identity/lab", 100);
      return report;
    } finally {
      await page?.close().catch(() => undefined);
      this.labBusy.delete(id);
    }
  }
  async labReport(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id))
      throw new IdentityError("invalid_report_id", "Invalid lab report id");
    const r = await this.d.store.read<LabReport>(`identity/lab/${id}.json`);
    if (!r) throw new IdentityError("report_not_found", "Lab report not found", 404);
    return r;
  }
  async labs() {
    const reports = await Promise.all(
      (await this.d.store.list("identity/lab"))
        .filter((f) => f.endsWith(".json"))
        .map((f) => this.d.store.read<LabReport>(`identity/lab/${f}`)),
    );
    return reports
      .filter((r): r is LabReport => !!r)
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 100);
  }
  private async prune(dir: string, cap: number) {
    const files = await this.d.store.list(dir);
    if (files.length <= cap) return;
    const values = await Promise.all(
      files.map(async (f) => ({
        f,
        at: (await this.d.store.read<{ at?: string }>(`${dir}/${f}`))?.at ?? "",
      })),
    );
    for (const x of values.sort((a, b) => b.at.localeCompare(a.at)).slice(cap))
      await this.d.store.remove(`${dir}/${x.f}`);
  }
  async checkContinuity(options: StartSessionOptions): Promise<Continuity> {
    const key = keyFor(options);
    if (!key)
      throw new IdentityError(
        "continuity_identity_required",
        "Use an identity, saved browser or cookie set to track continuity",
      );
    const egress = options.egress ?? (options.proxyUrl ? "custom" : "direct");
    let route: RouteObservation = {
      egress,
      publicIp: null,
      country: null,
      healthy: null,
      at: now(),
    };
    try {
      const resolved = options.proxyUrl
        ? { proxyUrl: options.proxyUrl }
        : await this.d.resolveEgress?.(egress);
      if (resolved?.proxyUrl && !options.proxyUrl) {
        options.proxyUrl = resolved.proxyUrl;
        options.proxyLabel ??= egress;
      }
      const probe = await this.d.egressProbe?.(egress, resolved?.proxyUrl);
      route = { ...route, ...probe };
      if (resolved?.proxyUrl) {
        const u = new URL(resolved.proxyUrl);
        route.upstream = `${u.protocol}//${u.hostname}:${u.port}`;
      }
    } catch {
      route.healthy = false;
    }
    const previous = await this.d.store.read<RouteObservation>(
      `identity/continuity/${hash(key)}.json`,
    );
    const changes = previous
      ? ["egress", "upstream", "publicIp", "country"].filter(
          (k) => previous[k as keyof RouteObservation] !== route[k as keyof RouteObservation],
        )
      : [];
    const status =
      route.healthy !== true || !route.publicIp
        ? "unavailable"
        : !previous
        ? "new"
        : changes.length
        ? "drift"
        : "stable";
    const token = hash(JSON.stringify({ key, previous, current: { ...route, at: undefined } }));
    return { key, previous, current: route, changes, status, token };
  }
  publicContinuity(c: Continuity) {
    const redact = (r?: RouteObservation) =>
      r
        ? {
            egress: r.egress,
            country: r.country,
            healthy: r.healthy,
            at: r.at,
            publicIpHash: r.publicIp ? hash(r.publicIp).slice(0, 16) : null,
            upstreamHash: r.upstream ? hash(r.upstream).slice(0, 16) : null,
          }
        : null;
    return {
      status: c.status,
      changes: c.changes,
      previous: redact(c.previous),
      current: redact(c.current),
      confirmationToken: c.token,
      limits: [
        "Node proxy health observation; browser leak diagnostics are separate",
        "Public IP and upstream are stored privately and hashed in this report",
      ],
    };
  }
  async sessionContinuity(id: string) {
    const o = this.d.getOptions(id);
    if (!o) throw new IdentityError("session_not_found", "Session options unavailable", 404);
    const c = await this.checkContinuity({ ...o });
    this.continuity.set(id, c);
    return this.publicContinuity(c);
  }
  async previewContinuity(options: StartSessionOptions) {
    return this.publicContinuity(await this.checkContinuity(options));
  }
  async confirmContinuity(id: string, token: string) {
    const o = this.d.getOptions(id);
    if (!o) throw new IdentityError("session_not_found", "Session options unavailable", 404);
    return this.serial(`continuity:${keyFor(o)}`, async () => {
      const c = await this.checkContinuity({ ...o });
      if (c.token !== token)
        throw new IdentityError(
          "continuity_changed",
          "Route changed since confirmation was prepared",
          409,
        );
      if (c.current.healthy !== true || !c.current.publicIp)
        throw new IdentityError(
          "continuity_unverified",
          "Cannot mark an unverified route successful",
          409,
        );
      await this.d.store.write(`identity/continuity/${hash(c.key)}.json`, c.current);
      return this.publicContinuity({ ...c, previous: c.current, changes: [], status: "stable" });
    });
  }
  async resetContinuity(name: string) {
    Name.parse(name);
    const profile = await this.profile(name);
    const keys = new Set([
      `identity-${name}`,
      keyFor({ credentials: undefined, ...profile.bindings }),
    ]);
    for (const key of keys)
      if (key) await this.d.store.remove(`identity/continuity/${hash(key)}.json`);
  }
  async close() {
    await this.collector.close();
    await Promise.allSettled([...this.locks.values()]);
  }
}
