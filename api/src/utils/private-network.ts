import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPublicAddress, prohibitedNames } from "../services/navigation-policy.js";

export interface PrivateNetworkCheckOptions {
  /** Hosts (and their subdomains) that stay reachable although they are private. */
  allowHosts?: string[];
  /** Injectable resolver for tests. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** How long an answer for a name is kept. */
  ttlMs?: number;
  dnsTimeoutMs?: number;
  now?: () => number;
}

/** Says whether a request URL targets a private, loopback, link-local or reserved address. */
export type PrivateNetworkCheck = (url: string) => Promise<boolean>;

const MAX_CACHED_NAMES = 500;
const NETWORK_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);

const defaultResolver = async (hostname: string) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

const ownPrefixes = new Set<string>();

/**
 * Names a page the API itself serves beside the browser (the identity
 * fixture, under a path only the API knows) so that a session with
 * `blockPrivateNetwork` can still open it. Returns what takes the entry away.
 */
export function trustOwnUrlPrefix(prefix: string): () => void {
  ownPrefixes.add(prefix);
  return () => {
    ownPrefixes.delete(prefix);
  };
}

export function parseHostList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[\s,]+/)
    .map((host) => host.trim().toLowerCase().replace(/\.$/, ""))
    .filter(Boolean);
}

/**
 * The check behind the `blockPrivateNetwork` session option.
 *
 * A literal address is judged as it is; a name is resolved here and refused
 * when any of its addresses is not public. A name that does not exist here
 * goes through: the browser cannot reach it either. Any other resolver failure
 * refuses the request. Answers are kept for a short time, so a name that
 * changes its address between this lookup and Chrome's own is not caught.
 */
export function createPrivateNetworkCheck(
  options: PrivateNetworkCheckOptions = {},
): PrivateNetworkCheck {
  const allow = options.allowHosts ?? [];
  const resolve = options.resolve ?? defaultResolver;
  const ttlMs = options.ttlMs ?? 30_000;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { until: number; verdict: Promise<boolean> }>();

  const judgeName = async (hostname: string): Promise<boolean> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const addresses = await Promise.race([
        resolve(hostname),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("DNS lookup timed out")),
            options.dnsTimeoutMs ?? 5000,
          );
          timer.unref();
        }),
      ]);
      return !addresses.length || addresses.some((address) => !isPublicAddress(address));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      return code !== "ENOTFOUND" && code !== "ENODATA";
    } finally {
      clearTimeout(timer);
    }
  };

  return async (raw: string): Promise<boolean> => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return false;
    }
    if (!NETWORK_PROTOCOLS.has(url.protocol)) return false;
    for (const prefix of ownPrefixes) if (url.href.startsWith(prefix)) return false;
    const hostname = url.hostname
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "")
      .toLowerCase();
    if (!hostname) return false;
    if (allow.some((host) => hostname === host || hostname.endsWith(`.${host}`))) return false;
    if (prohibitedNames.has(hostname) || hostname.endsWith(".localhost")) return true;
    if (isIP(hostname)) return !isPublicAddress(hostname);

    const at = now();
    const cached = cache.get(hostname);
    if (cached && cached.until > at) return cached.verdict;
    if (cache.size >= MAX_CACHED_NAMES) {
      for (const [name, entry] of cache) if (entry.until <= at) cache.delete(name);
      if (cache.size >= MAX_CACHED_NAMES) cache.clear();
    }
    const verdict = judgeName(hostname);
    cache.set(hostname, { until: at + ttlMs, verdict });
    return verdict;
  };
}
