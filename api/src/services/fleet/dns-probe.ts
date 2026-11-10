import type { Page } from "puppeteer-core";
export interface DnsObservation { resolverIp: string; queryType: string; transport: string; observedAt: string }
/** Register a short-lived nonce before asking Chrome to resolve it, then read authoritative observations. */
export async function browserDnsProbe(page: Page, endpoint = process.env.STEEL_DNS_DIAGNOSTICS_URL, token = process.env.STEEL_DNS_DIAGNOSTICS_TOKEN): Promise<{ channel: "dns"; status: "pass" | "fail" | "untested"; reason: string; observations?: DnsObservation[] }> {
  if (!endpoint || !token) return { channel: "dns", status: "untested", reason: "Owned authoritative DNS collector is not configured" };
  const base = new URL(endpoint); if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) return { channel: "dns", status: "untested", reason: "Authoritative DNS collector configuration is invalid" };
  const headers = { authorization: `Bearer ${token}` };
  try {
    const created = await fetch(new URL("/probes", base), { method: "POST", headers, signal: AbortSignal.timeout(5000) }); if (!created.ok) throw new Error("collector_unavailable");
    const probe = await created.json() as { id: string; hostname: string };
    if (!/^[a-f0-9]{32}$/.test(probe.id) || !new RegExp(`^${probe.id}\\.[a-z0-9.-]+$`).test(probe.hostname)) throw new Error("invalid_probe");
    // TLS failure is expected for the nonce hostname. DNS is still observed; TLS is never bypassed.
    await page.evaluate(async hostname => { try { await fetch(`https://${hostname}/steel-dns-probe`, { credentials: "omit", mode: "no-cors", cache: "no-store", signal: AbortSignal.timeout(5000) }); } catch { /* The authoritative observation is the result, not this HTTP response. */ } }, probe.hostname);
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await fetch(new URL(`/probes/${probe.id}`, base), { headers, signal: AbortSignal.timeout(3000) }); if (!response.ok) throw new Error("collector_unavailable");
      const data = await response.json() as { observations?: DnsObservation[] };
      if (data.observations?.length) return { channel: "dns", status: "pass", reason: "Owned authoritative server observed nonce DNS queries. Resolver addresses are evidence of the DNS route, not the browser's public HTTP IP.", observations: data.observations.slice(0, 30).map(o => ({ resolverIp: String(o.resolverIp).slice(0, 64), queryType: String(o.queryType).slice(0, 10), transport: String(o.transport).slice(0, 10), observedAt: String(o.observedAt).slice(0, 40) })) };
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 250));
    }
    return { channel: "dns", status: "fail", reason: "No authoritative DNS query was observed for this browser nonce before the deadline" };
  } catch { return { channel: "dns", status: "untested", reason: "Owned authoritative DNS collector is unavailable or returned an invalid probe" }; }
}
