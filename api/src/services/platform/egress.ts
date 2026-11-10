import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { z } from "zod";
import { nordVpnConfigured, nordVpnProxy } from "../nordvpn.service.js";

const profilesSchema = z.record(
  z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  z.object({
    proxyUrl: z
      .string()
      .url()
      .refine((value) =>
        ["http:", "https:", "socks:", "socks4:", "socks5:"].includes(new URL(value).protocol),
      ),
    label: z.string().max(200).optional(),
  }),
);
export interface EgressSummary {
  name: string;
  label: string;
  type: "direct" | "proxy" | "nordvpn";
  healthy: boolean | null;
  publicIp: string | null;
  country: string | null;
  checkedAt: string | null;
}
export class EgressError extends Error {
  readonly statusCode = 400;
  readonly code = "invalid_egress";
}

export class EgressService {
  private profiles: z.infer<typeof profilesSchema>;
  private health = new Map<string, { at: number; summary: EgressSummary }>();
  private checks = new Map<string, Promise<EgressSummary>>();
  constructor(
    rawProfiles = "{}",
    readonly defaultName = "direct",
  ) {
    this.profiles = profilesSchema.parse(JSON.parse(rawProfiles));
    if (Object.hasOwn(this.profiles, "direct"))
      throw new EgressError("The built-in direct egress cannot be overridden");
    this.assertName(defaultName);
  }
  private assertName(name: string): void {
    if (name === "direct" || Object.hasOwn(this.profiles, name)) return;
    if (/^nordvpn(?::[A-Za-z]{2})?$/.test(name) && nordVpnConfigured()) return;
    throw new EgressError(`Unknown or unconfigured egress: ${name}`);
  }
  async resolve(
    name = this.defaultName,
  ): Promise<{ name: string; proxyUrl?: string; proxyLabel?: string }> {
    this.assertName(name);
    if (name === "direct") return { name };
    if (name.startsWith("nordvpn")) {
      const resolved = await nordVpnProxy(name.split(":")[1]);
      return { name, proxyUrl: resolved.url, proxyLabel: name };
    }
    return {
      name,
      proxyUrl: this.profiles[name].proxyUrl,
      proxyLabel: this.profiles[name].label ?? name,
    };
  }
  private describe(name: string): EgressSummary {
    return {
      name,
      label: this.profiles[name]?.label ?? name,
      type: name === "direct" ? "direct" : name.startsWith("nordvpn") ? "nordvpn" : "proxy",
      healthy: null,
      publicIp: null,
      country: null,
      checkedAt: null,
    };
  }
  async check(name: string): Promise<EgressSummary> {
    this.assertName(name);
    const cached = this.health.get(name);
    if (cached && Date.now() - cached.at < 600_000) return cached.summary;
    const pending = this.checks.get(name);
    if (pending) return pending;
    const task = (async () => {
      const summary = this.describe(name);
      try {
        const { proxyUrl } = await this.resolve(name);
        const agent = proxyUrl
          ? /^socks/.test(proxyUrl)
            ? new SocksProxyAgent(proxyUrl)
            : new HttpsProxyAgent(proxyUrl)
          : undefined;
        const response = await axios.get<string>("https://www.cloudflare.com/cdn-cgi/trace", {
          timeout: 5000,
          proxy: false,
          httpsAgent: agent,
          responseType: "text",
          maxRedirects: 0,
          maxContentLength: 65536,
        });
        const trace = Object.fromEntries(
          response.data.split("\n").map((line) => line.split("=", 2)),
        );
        summary.healthy = !!trace.ip;
        summary.publicIp = trace.ip || null;
        summary.country = trace.loc || null;
      } catch {
        summary.healthy = false;
      }
      summary.checkedAt = new Date().toISOString();
      this.health.set(name, { at: Date.now(), summary });
      return summary;
    })();
    this.checks.set(name, task);
    try {
      return await task;
    } finally {
      this.checks.delete(name);
    }
  }
  async list(): Promise<{ default: string; profiles: EgressSummary[] }> {
    const names = ["direct", ...Object.keys(this.profiles)];
    if (nordVpnConfigured())
      names.push("nordvpn", "nordvpn:US", "nordvpn:GB", "nordvpn:FR", "nordvpn:DE", "nordvpn:NL");
    if (!names.includes(this.defaultName)) names.push(this.defaultName);
    // Check known entries concurrently; no proxy credentials ever enter the summary.
    return {
      default: this.defaultName,
      profiles: await Promise.all(names.map((name) => this.check(name))),
    };
  }
}
