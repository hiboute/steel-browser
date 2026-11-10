import { env } from "../env.js";

/**
 * NordVPN for a session: picks a recommended NordVPN server (optionally in a
 * country) that offers Nord's HTTPS proxy, and returns it as an upstream
 * proxy URL with the account's service credentials
 * (NORDVPN_SERVICE_USER / NORDVPN_SERVICE_PASS, from Nord Account > Set up
 * NordVPN manually > Service credentials).
 */
const API = "https://api.nordvpn.com/v1";
const PROXY_PORT = 89;
const DAY_MS = 24 * 60 * 60 * 1000;

export class NordVpnError extends Error {}

let countries: { at: number; byCode: Map<string, number> } | null = null;

export function nordVpnConfigured(): boolean {
  return Boolean(env.NORDVPN_SERVICE_USER && env.NORDVPN_SERVICE_PASS);
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new NordVpnError(`NordVPN API ${res.status} for ${url.replace(API, "")}`);
  return res.json();
}

async function countryId(code: string): Promise<number> {
  if (!countries || Date.now() - countries.at > DAY_MS) {
    const list = (await getJson(`${API}/servers/countries`)) as { id: number; code: string }[];
    countries = { at: Date.now(), byCode: new Map(list.map((c) => [c.code.toUpperCase(), c.id])) };
  }
  const id = countries.byCode.get(code.toUpperCase());
  if (id === undefined) throw new NordVpnError(`NordVPN has no servers in "${code}".`);
  return id;
}

/** The hostname of a recommended NordVPN HTTPS-proxy server. */
export async function pickNordServer(country?: string): Promise<string> {
  const params = new URLSearchParams({
    "filters[servers_technologies][identifier]": "proxy_ssl",
    limit: "5",
  });
  if (country) params.set("filters[country_id]", String(await countryId(country)));
  const servers = (await getJson(`${API}/servers/recommendations?${params}`)) as {
    hostname?: string;
    status?: string;
  }[];
  const server = servers.find((s) => s.hostname && (s.status ?? "online") === "online");
  if (!server?.hostname) {
    throw new NordVpnError(`No NordVPN proxy server available${country ? ` in ${country}` : ""}.`);
  }
  return server.hostname;
}

/**
 * The name to dial for a server's HTTPS proxy. The proxy's certificate covers
 * only *.proxy.nordvpn.com, so nl1279.nordvpn.com must be dialled as
 * nl1279.proxy.nordvpn.com (same IP) or the TLS handshake to the proxy fails.
 */
export function proxyHostFor(hostname: string): string {
  const m = /^([a-z0-9-]+)\.nordvpn\.com$/i.exec(hostname);
  return m ? `${m[1]}.proxy.nordvpn.com` : hostname;
}

/** An upstream proxy URL through NordVPN, plus a label without the credentials. */
export async function nordVpnProxy(country?: string): Promise<{ url: string; label: string }> {
  if (!nordVpnConfigured()) {
    throw new NordVpnError(
      "NordVPN is not set up: NORDVPN_SERVICE_USER and NORDVPN_SERVICE_PASS are missing.",
    );
  }
  const host = proxyHostFor(await pickNordServer(country));
  const user = encodeURIComponent(env.NORDVPN_SERVICE_USER!);
  const pass = encodeURIComponent(env.NORDVPN_SERVICE_PASS!);
  return { url: `https://${user}:${pass}@${host}:${PROXY_PORT}`, label: `nordvpn:${host}` };
}
