import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "fs/promises";
import path from "path";
import type { BrowserFingerprintWithHeaders } from "fingerprint-generator";
import { CookieData, LocalStorageData } from "./context/types.js";

export interface CookieCheck {
  url: string;
  loggedInSelector?: string;
  loggedOutSelector?: string;
  loggedOutUrlPattern?: string;
  textIncludes?: string;
  intervalHours?: number;
  enabled?: boolean;
}
export interface CookieCheckResult {
  ok: boolean;
  reason: string;
  finalUrl: string;
  durationMs: number;
}
export interface CookieHealth {
  lastCheckAt?: string;
  lastOkAt?: string;
  lastResult?: CookieCheckResult;
  consecutiveFailures: number;
  /** Last warned expiry, so a scheduler restart does not repeat a notification. */
  warnedExpiry?: string;
}
export interface CookieFingerprint {
  fingerprint?: BrowserFingerprintWithHeaders;
  userAgent?: string;
  dimensions?: { width: number; height: number };
  timezone?: string;
  locale?: string;
}
export interface CookieSetSettings {
  description?: string;
  check?: CookieCheck;
  /** Cookie names or complete cookie keys returned by cookieKey(). */
  authCookies?: string[];
  writeBack?: boolean;
  pinFingerprint?: boolean;
  egress?: string;
  acl?: { clients: string[] };
}
/** V1 files remain readable; new fields are optional on disk. */
export interface CookieSet extends CookieSetSettings {
  name: string;
  cookies: CookieData[];
  localStorage?: Record<string, LocalStorageData>;
  domains: string[];
  sourceSessionId?: string;
  createdAt: string;
  updatedAt: string;
  health?: CookieHealth;
  previous?: {
    cookies: CookieData[];
    localStorage?: Record<string, LocalStorageData>;
    updatedAt: string;
  };
  fingerprint?: CookieFingerprint;
  lastUsedAt?: string;
  useCount?: number;
}
export interface CookieSetSummary extends CookieSetSettings {
  name: string;
  domains: string[];
  sourceSessionId?: string;
  createdAt: string;
  updatedAt: string;
  cookieCount: number;
  originCount: number;
  expiresAt: string | null;
  authExpiresAt: string | null;
  health: CookieHealth & { status: "ok" | "expiring" | "expired" | "failing" | "unknown" };
  hasFingerprint: boolean;
  hasPrevious: boolean;
  lastUsedAt?: string;
  useCount: number;
}
export class CookieSetNotFoundError extends Error {
  constructor(name: string) {
    super(`Cookie set "${name}" not found`);
    this.name = "CookieSetNotFoundError";
  }
}
export class CookieSetDeniedError extends Error {
  constructor(name: string) {
    super(`Access to cookie set "${name}" is denied for this client`);
    this.name = "CookieSetDeniedError";
  }
}
export class CookieSetConflictError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
  }
}
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export function assertValidName(name: string) {
  if (!NAME.test(name))
    throw new Error(
      "Cookie set names are 1-64 characters: letters, digits, '.', '_' or '-', starting with a letter or digit",
    );
}
function normalizeDomain(value: string): string {
  let host = value.trim().toLowerCase();
  try {
    if (host.includes("://")) host = new URL(host).hostname;
  } catch {}
  return host.replace(/^\./, "");
}
function matchesDomain(host: string, domain: string) {
  const h = normalizeDomain(host),
    d = normalizeDomain(domain);
  return h === d || h.endsWith(`.${d}`);
}
function domainsOf(cookies: CookieData[], localStorage?: Record<string, LocalStorageData>) {
  const all = new Set<string>();
  for (const cookie of cookies) {
    const host = cookie.domain ?? (cookie.url ? normalizeDomain(cookie.url) : "");
    if (host) all.add(normalizeDomain(host));
  }
  for (const origin of Object.keys(localStorage ?? {})) all.add(normalizeDomain(origin));
  return Array.from(all).sort();
}
export function cookieKey(cookie: CookieData): string {
  return JSON.stringify([
    cookie.name,
    normalizeDomain(cookie.domain ?? cookie.url ?? ""),
    cookie.path ?? "/",
    cookie.partitionKey?.topLevelSite ?? "",
    cookie.partitionKey?.hasCrossSiteAncestor ?? false,
  ]);
}
export function filterByDomains(
  data: { cookies: CookieData[]; localStorage?: Record<string, LocalStorageData> },
  domains?: string[],
) {
  if (!domains || domains.length === 0) return data;
  const cookies = data.cookies.filter((cookie) =>
    domains.some((domain) => matchesDomain(cookie.domain ?? cookie.url ?? "", domain)),
  );
  const localStorage = Object.fromEntries(
    Object.entries(data.localStorage ?? {}).filter(([origin]) =>
      domains.some((domain) => matchesDomain(origin, domain)),
    ),
  );
  return { cookies, localStorage };
}
/** '*' and '?' are the only pattern syntax; all regex metacharacters are literal. */
export function clientAllowed(set: Pick<CookieSet, "acl">, client = "anonymous"): boolean {
  if (client === "ui" || !set.acl) return true;
  return set.acl.clients.some((pattern) =>
    new RegExp(
      `^${pattern
        .split("")
        .map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
        .join("")}$`,
      "u",
    ).test(client),
  );
}
function authCookiesOf(set: CookieSet): CookieData[] {
  if (set.authCookies?.length)
    return set.cookies.filter(
      (c) => set.authCookies!.includes(c.name) || set.authCookies!.includes(cookieKey(c)),
    );
  const httpOnly = set.cookies.filter((c) => c.httpOnly && !c.session && (c.expires ?? 0) > 0);
  return httpOnly.length ? httpOnly : set.cookies;
}
function expiry(cookies: CookieData[]): string | null {
  const values = cookies
    .filter((c) => !c.session && typeof c.expires === "number" && c.expires > 0)
    .map((c) => c.expires!);
  return values.length ? new Date(Math.min(...values) * 1000).toISOString() : null;
}
export interface CookieAuditDetail {
  client?: string;
  subject?: string;
  sessionId?: string;
  detail?: Record<string, unknown>;
}
export interface PrepareCookieSessionOptions extends CookieFingerprint {
  client?: string;
  browserProfile?: string;
  egress?: string;
  proxyUrl?: string;
  vpn?: unknown;
  sessionContext?: {
    cookies?: CookieData[];
    localStorage?: Record<string, LocalStorageData>;
    [key: string]: unknown;
  };
}

export class CookieLibraryService {
  private key: Buffer | null;
  private writes = new Map<string, Promise<unknown>>();
  public audit: (event: string, detail: CookieAuditDetail) => Promise<unknown> | unknown = () => {};
  public changed: (name: string, event: string) => void = () => {};
  constructor(
    private dir: string,
    secret?: string,
  ) {
    this.key = secret ? createHash("sha256").update(secret).digest() : null;
  }
  get encrypted() {
    return this.key !== null;
  }
  private file(name: string) {
    assertValidName(name);
    return path.join(this.dir, `${name}.json`);
  }
  private encode(set: CookieSet): string {
    const json = JSON.stringify(set);
    if (!this.key) return json;
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
    return JSON.stringify({
      v: 1,
      alg: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    });
  }
  private decode(raw: string, name: string): CookieSet {
    const parsed = JSON.parse(raw);
    if (parsed?.alg === "aes-256-gcm") {
      if (!this.key)
        throw new Error(`Cookie set "${name}" is encrypted and COOKIE_LIBRARY_KEY is not set`);
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(parsed.iv, "base64"));
      decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
      return JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(parsed.data, "base64")),
          decipher.final(),
        ]).toString("utf8"),
      );
    }
    return parsed as CookieSet;
  }
  async get(name: string): Promise<CookieSet> {
    try {
      return this.decode(await readFile(this.file(name), "utf8"), name);
    } catch (error: any) {
      if (error?.code === "ENOENT") throw new CookieSetNotFoundError(name);
      throw error;
    }
  }
  async assertAccess(name: string, client = "anonymous"): Promise<CookieSet> {
    const set = await this.get(name);
    if (!clientAllowed(set, client)) {
      await this.audit("cookieset.denied", { client, subject: name });
      throw new CookieSetDeniedError(name);
    }
    return set;
  }
  async list(client?: string): Promise<CookieSetSummary[]> {
    await mkdir(this.dir, { recursive: true });
    const sets: CookieSetSummary[] = [];
    for (const file of (await readdir(this.dir)).filter((f) => f.endsWith(".json"))) {
      const name = file.slice(0, -5);
      if (!NAME.test(name)) continue;
      try {
        const set = await this.get(name);
        if (client === undefined || clientAllowed(set, client)) sets.push(summarize(set));
      } catch {
        /* An unreadable set must not break the entire list. */
      }
    }
    return sets.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  private async exclusive<T>(name: string, fn: () => Promise<T>): Promise<T> {
    assertValidName(name);
    const previous = this.writes.get(name) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(fn);
    this.writes.set(name, pending);
    try {
      return await pending;
    } finally {
      if (this.writes.get(name) === pending) this.writes.delete(name);
    }
  }
  private async write(set: CookieSet): Promise<CookieSet> {
    const file = this.file(set.name);
    await mkdir(this.dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, this.encode(set), { mode: 0o600 });
      await rename(tmp, file);
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
    }
    return set;
  }
  async save(input: {
    name: string;
    description?: string;
    cookies: CookieData[];
    localStorage?: Record<string, LocalStorageData>;
    sourceSessionId?: string;
    fingerprint?: CookieFingerprint;
  }): Promise<CookieSet> {
    return this.exclusive(input.name, async () => {
      const existing = await this.get(input.name).catch((error) => {
        if (error instanceof CookieSetNotFoundError) return null;
        throw error;
      });
      const now = new Date().toISOString();
      return this.write({
        ...existing,
        name: input.name,
        description: input.description ?? existing?.description,
        cookies: input.cookies,
        localStorage: input.localStorage,
        domains: domainsOf(input.cookies, input.localStorage),
        sourceSessionId: input.sourceSessionId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        fingerprint: existing?.fingerprint ?? input.fingerprint,
        writeBack: existing?.writeBack ?? true,
        pinFingerprint: existing?.pinFingerprint ?? true,
      });
    });
  }
  async update(name: string, changes: CookieSetSettings): Promise<CookieSet> {
    return this.exclusive(name, async () =>
      this.write({ ...(await this.get(name)), ...changes, updatedAt: new Date().toISOString() }),
    );
  }
  async recordHealth(
    name: string,
    result: CookieCheckResult,
  ): Promise<{ previous?: CookieHealth; set: CookieSet }> {
    return this.exclusive(name, async () => {
      const set = await this.get(name),
        now = new Date().toISOString(),
        previous = set.health;
      set.health = {
        ...previous,
        lastCheckAt: now,
        lastOkAt: result.ok ? now : previous?.lastOkAt,
        lastResult: result,
        consecutiveFailures: result.ok ? 0 : (previous?.consecutiveFailures ?? 0) + 1,
      };
      return { previous, set: await this.write(set) };
    });
  }
  async markExpiryWarned(name: string, expiresAt: string): Promise<void> {
    await this.exclusive(name, async () => {
      const set = await this.get(name);
      set.health = { consecutiveFailures: 0, ...set.health, warnedExpiry: expiresAt };
      await this.write(set);
    });
  }
  async delete(name: string): Promise<void> {
    await this.exclusive(name, async () => {
      await this.get(name);
      await rm(this.file(name));
    });
  }
  async restorePrevious(name: string): Promise<CookieSet> {
    return this.exclusive(name, async () => {
      const set = await this.get(name);
      if (!set.previous)
        throw new CookieSetConflictError("Cookie set has no previous version", "no_previous");
      const previous = {
        cookies: set.cookies,
        localStorage: set.localStorage,
        updatedAt: set.updatedAt,
      };
      return this.write({
        ...set,
        cookies: set.previous.cookies,
        localStorage: set.previous.localStorage,
        domains: domainsOf(set.previous.cookies, set.previous.localStorage),
        previous,
        updatedAt: new Date().toISOString(),
        health: undefined,
      });
    });
  }
  /** Refresh credentials without removing cookies on partial/logged-out sessions. */
  async writeBack(
    name: string,
    state: { cookies?: CookieData[]; localStorage?: Record<string, LocalStorageData> },
  ): Promise<{ updated: boolean; reason?: string; set: CookieSet }> {
    return this.exclusive(name, async () => {
      const set = await this.get(name);
      if (set.writeBack === false) return { updated: false, reason: "disabled", set };
      // An empty set has no trusted domain boundary to grow into automatically.
      if (!set.domains.length) return { updated: false, reason: "no_domains", set };
      const selected = filterByDomains(
        { cookies: state.cookies ?? [], localStorage: state.localStorage },
        set.domains,
      );
      const incoming = new Map(selected.cookies.map((c) => [cookieKey(c), c]));
      const auth = authCookiesOf(set);
      if (auth.length && auth.filter((c) => !incoming.has(cookieKey(c))).length > auth.length / 2)
        return { updated: false, reason: "auth_cookies_missing", set };
      const merged = new Map(set.cookies.map((c) => [cookieKey(c), c]));
      let changed = false;
      for (const [key, cookie] of incoming) {
        const old = merged.get(key);
        if (!old || old.value !== cookie.value || (cookie.expires ?? -1) > (old.expires ?? -1)) {
          merged.set(key, cookie);
          changed = true;
        }
      }
      const localStorage = { ...set.localStorage };
      for (const [origin, data] of Object.entries(selected.localStorage ?? {})) {
        const updated = { ...localStorage[origin], ...data };
        if (JSON.stringify(updated) !== JSON.stringify(localStorage[origin])) changed = true;
        localStorage[origin] = updated;
      }
      if (!changed) return { updated: false, reason: "unchanged", set };
      const updated = await this.write({
        ...set,
        cookies: [...merged.values()],
        localStorage,
        previous: {
          cookies: set.cookies,
          localStorage: set.localStorage,
          updatedAt: set.updatedAt,
        },
        updatedAt: new Date().toISOString(),
      });
      return { updated: true, set: updated };
    });
  }
  async resolve(
    names: string[],
    client = "anonymous",
  ): Promise<{ cookies: CookieData[]; localStorage: Record<string, LocalStorageData> }> {
    const cookies = new Map<string, CookieData>(),
      localStorage: Record<string, LocalStorageData> = {};
    for (const name of names) {
      const set = await this.assertAccess(name, client);
      for (const cookie of set.cookies) cookies.set(cookieKey(cookie), cookie);
      for (const [origin, items] of Object.entries(set.localStorage ?? {}))
        localStorage[origin] = { ...localStorage[origin], ...items };
    }
    return { cookies: [...cookies.values()], localStorage };
  }
  async prepareSession(
    names: string[],
    options: PrepareCookieSessionOptions = {},
  ): Promise<PrepareCookieSessionOptions> {
    const loaded = await Promise.all(names.map((name) => this.assertAccess(name, options.client)));
    const context = await this.resolve(names, options.client);
    const firstPin = loaded.find((set) => set.pinFingerprint !== false && set.fingerprint)
      ?.fingerprint;
    const own = options.sessionContext ?? {};
    const cookies = new Map(context.cookies.map((c) => [cookieKey(c), c]));
    for (const cookie of own.cookies ?? []) cookies.set(cookieKey(cookie), cookie);
    const localStorage = { ...context.localStorage };
    for (const [origin, items] of Object.entries(own.localStorage ?? {}))
      localStorage[origin] = { ...localStorage[origin], ...items };
    const identity = options.browserProfile ? {} : firstPin ?? {};
    return {
      ...identity,
      ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)),
      egress:
        options.egress ??
        (options.proxyUrl || options.vpn ? undefined : loaded.find((set) => set.egress)?.egress),
      sessionContext: { ...own, cookies: [...cookies.values()], localStorage },
    };
  }
  /** Called only after launch succeeds; rejected launches do not count as use. */
  async recordUse(
    names: string[],
    client: string,
    sessionId: string,
    fingerprint?: CookieFingerprint,
  ): Promise<void> {
    for (const name of new Set(names)) {
      await this.exclusive(name, async () => {
        const set = await this.get(name);
        await this.write({
          ...set,
          lastUsedAt: new Date().toISOString(),
          useCount: (set.useCount ?? 0) + 1,
          fingerprint: set.fingerprint ?? fingerprint,
        });
      });
      await this.audit("cookieset.loaded", { client, subject: name, sessionId });
    }
  }
}

/** Explicit whitelist: never spread CookieSet, which contains credentials and previous values. */
export function summarize(set: CookieSet, now = Date.now(), warnDays = 3): CookieSetSummary {
  const authExpiresAt = expiry(authCookiesOf(set));
  const status =
    authExpiresAt && Date.parse(authExpiresAt) <= now
      ? "expired"
      : set.health?.lastResult?.ok === false
      ? "failing"
      : authExpiresAt && Date.parse(authExpiresAt) <= now + warnDays * 86_400_000
      ? "expiring"
      : set.health?.lastResult?.ok
      ? "ok"
      : "unknown";
  return {
    name: set.name,
    description: set.description,
    domains: set.domains,
    sourceSessionId: set.sourceSessionId,
    createdAt: set.createdAt,
    updatedAt: set.updatedAt,
    cookieCount: set.cookies.length,
    originCount: Object.keys(set.localStorage ?? {}).length,
    expiresAt: expiry(set.cookies),
    authExpiresAt,
    check: set.check,
    authCookies: set.authCookies,
    writeBack: set.writeBack ?? true,
    egress: set.egress,
    pinFingerprint: set.pinFingerprint ?? true,
    hasFingerprint: !!set.fingerprint,
    acl: set.acl,
    lastUsedAt: set.lastUsedAt,
    useCount: set.useCount ?? 0,
    hasPrevious: !!set.previous,
    health: { consecutiveFailures: 0, ...set.health, status },
  };
}
