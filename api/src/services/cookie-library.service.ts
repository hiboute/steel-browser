import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "fs/promises";
import path from "path";
import { CookieData, LocalStorageData } from "./context/types.js";

/**
 * A named, reusable set of browser credentials: cookies plus localStorage,
 * captured from a logged-in session (or imported) and injected into new
 * sessions with `cookieSets: ["<name>"]`.
 */
export interface CookieSet {
  name: string;
  description?: string;
  cookies: CookieData[];
  localStorage?: Record<string, LocalStorageData>;
  /** Sites the set covers, derived from the cookies and localStorage origins. */
  domains: string[];
  sourceSessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export type CookieSetSummary = Omit<CookieSet, "cookies" | "localStorage"> & {
  cookieCount: number;
  originCount: number;
  /** Earliest expiry among non-session cookies, ISO, or null when none expire. */
  expiresAt: string | null;
};

export class CookieSetNotFoundError extends Error {
  constructor(name: string) {
    super(`Cookie set "${name}" not found`);
    this.name = "CookieSetNotFoundError";
  }
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function assertValidName(name: string) {
  if (!NAME.test(name)) {
    throw new Error(
      "Cookie set names are 1-64 characters: letters, digits, '.', '_' or '-', starting with a letter or digit",
    );
  }
}

function normalizeDomain(value: string): string {
  let host = value.trim().toLowerCase();
  try {
    if (host.includes("://")) host = new URL(host).hostname;
  } catch {
    // keep as is
  }
  return host.replace(/^\./, "");
}

/** True when `host` is `domain` or one of its subdomains. */
function matchesDomain(host: string, domain: string) {
  const h = normalizeDomain(host);
  const d = normalizeDomain(domain);
  return h === d || h.endsWith(`.${d}`);
}

function domainsOf(cookies: CookieData[], localStorage?: Record<string, LocalStorageData>) {
  const all = new Set<string>();
  for (const cookie of cookies) {
    const host = cookie.domain ?? (cookie.url ? normalizeDomain(cookie.url) : "");
    if (host) all.add(normalizeDomain(host));
  }
  for (const origin of Object.keys(localStorage ?? {})) {
    all.add(normalizeDomain(origin));
  }
  return Array.from(all).sort();
}

/** Keeps only the cookies and localStorage origins under the given domains. */
export function filterByDomains(
  data: { cookies: CookieData[]; localStorage?: Record<string, LocalStorageData> },
  domains?: string[],
) {
  if (!domains || domains.length === 0) return data;
  const cookies = data.cookies.filter((cookie) => {
    const host = cookie.domain ?? (cookie.url ? normalizeDomain(cookie.url) : "");
    return domains.some((domain) => matchesDomain(host, domain));
  });
  const localStorage = Object.fromEntries(
    Object.entries(data.localStorage ?? {}).filter(([origin]) =>
      domains.some((domain) => matchesDomain(origin, domain)),
    ),
  );
  return { cookies, localStorage };
}

/**
 * Stores each set as one JSON file. When a key is given (COOKIE_LIBRARY_KEY),
 * files are encrypted with AES-256-GCM, since cookies are live credentials.
 */
export class CookieLibraryService {
  private key: Buffer | null;

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
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
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
    if (parsed && parsed.alg === "aes-256-gcm") {
      if (!this.key) {
        throw new Error(`Cookie set "${name}" is encrypted and COOKIE_LIBRARY_KEY is not set`);
      }
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(parsed.iv, "base64"));
      decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
      const json = Buffer.concat([
        decipher.update(Buffer.from(parsed.data, "base64")),
        decipher.final(),
      ]).toString("utf8");
      return JSON.parse(json);
    }
    return parsed as CookieSet;
  }

  async get(name: string): Promise<CookieSet> {
    let raw: string;
    try {
      raw = await readFile(this.file(name), "utf8");
    } catch (error: any) {
      if (error?.code === "ENOENT") throw new CookieSetNotFoundError(name);
      throw error;
    }
    return this.decode(raw, name);
  }

  async list(): Promise<CookieSetSummary[]> {
    await mkdir(this.dir, { recursive: true });
    const files = (await readdir(this.dir)).filter((f) => f.endsWith(".json"));
    const sets: CookieSetSummary[] = [];
    for (const file of files) {
      const name = file.slice(0, -".json".length);
      if (!NAME.test(name)) continue;
      try {
        sets.push(summarize(await this.get(name)));
      } catch {
        // unreadable (wrong key, corrupt): skip rather than break the listing
      }
    }
    return sets.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async save(input: {
    name: string;
    description?: string;
    cookies: CookieData[];
    localStorage?: Record<string, LocalStorageData>;
    sourceSessionId?: string;
  }): Promise<CookieSet> {
    const file = this.file(input.name);
    await mkdir(this.dir, { recursive: true });
    const existing = await this.get(input.name).catch(() => null);
    const now = new Date().toISOString();
    const set: CookieSet = {
      name: input.name,
      description: input.description ?? existing?.description,
      cookies: input.cookies,
      localStorage:
        input.localStorage && Object.keys(input.localStorage).length > 0
          ? input.localStorage
          : undefined,
      domains: domainsOf(input.cookies, input.localStorage),
      sourceSessionId: input.sourceSessionId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, this.encode(set), { mode: 0o600 });
    await rename(tmp, file);
    return set;
  }

  async delete(name: string): Promise<void> {
    await this.get(name);
    await rm(this.file(name));
  }

  /** Merges several sets, later ones winning on the same cookie (name, domain, path). */
  async resolve(names: string[]): Promise<{
    cookies: CookieData[];
    localStorage: Record<string, LocalStorageData>;
  }> {
    const cookies = new Map<string, CookieData>();
    const localStorage: Record<string, LocalStorageData> = {};
    for (const name of names) {
      const set = await this.get(name);
      for (const cookie of set.cookies) {
        cookies.set(
          `${cookie.name}|${cookie.domain ?? cookie.url ?? ""}|${cookie.path ?? "/"}`,
          cookie,
        );
      }
      for (const [origin, items] of Object.entries(set.localStorage ?? {})) {
        localStorage[origin] = { ...(localStorage[origin] ?? {}), ...items };
      }
    }
    return { cookies: Array.from(cookies.values()), localStorage };
  }
}

export function summarize(set: CookieSet): CookieSetSummary {
  const { cookies, localStorage, ...rest } = set;
  const expiries = cookies
    .filter((c) => !c.session && typeof c.expires === "number" && c.expires > 0)
    .map((c) => c.expires as number);
  return {
    ...rest,
    cookieCount: cookies.length,
    originCount: Object.keys(localStorage ?? {}).length,
    expiresAt: expiries.length ? new Date(Math.min(...expiries) * 1000).toISOString() : null,
  };
}
