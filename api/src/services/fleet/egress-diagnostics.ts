import { randomUUID } from "node:crypto";
import type { SessionService } from "../session.service.js";
import type { PlatformStore } from "../platform/store.js";
import { FleetError } from "./types.js";
import { browserDnsProbe, type DnsObservation } from "./dns-probe.js";

export interface EgressProbe { channel: "http" | "websocket" | "worker" | "webrtc" | "dns" | "ipv6"; status: "pass" | "fail" | "untested"; reason: string; observedIp?: string; headers?: Record<string, string>; candidates?: string[]; observations?: DnsObservation[] }
export interface EgressReport { id: string; sessionId: string; checkedAt: string; collectorOrigin: string | null; probes: EgressProbe[]; limits: string[] }
const untested = (channel: EgressProbe["channel"], reason: string): EgressProbe => ({ channel, status: "untested", reason });

/** Probe page and worker requests run in the real session browser, never Node's HTTP client. */
export class BrowserEgressDiagnostics {
  private running = new Map<string, Promise<EgressReport>>();
  constructor(private readonly sessions: SessionService, private readonly store: PlatformStore, private readonly collector = process.env.STEEL_DIAGNOSTICS_COLLECTOR, private readonly ipv6Collector = process.env.STEEL_DIAGNOSTICS_IPV6_COLLECTOR, private readonly stun = process.env.STEEL_DIAGNOSTICS_STUN_URL) {}
  async get(sessionId: string) { return await this.store.read<EgressReport>(`egress-diagnostics/${sessionId}.json`) ?? null; }
  async run(sessionId: string): Promise<EgressReport> {
    const existing = this.running.get(sessionId); if (existing) return existing;
    const task = this.probe(sessionId); this.running.set(sessionId, task);
    try { return await task; } finally { this.running.delete(sessionId); }
  }
  private async probe(sessionId: string): Promise<EgressReport> {
    const session = this.sessions.getSession(sessionId);
    if (!session) throw new FleetError("session_not_found", "Session not found", 404);
    const report: EgressReport = { id: randomUUID(), sessionId, checkedAt: new Date().toISOString(), collectorOrigin: null, probes: [], limits: ["A successful probe covers only the named channel at the recorded time; it is not a proof of undetectability or all future egress.", "DNS routing requires an authoritative DNS collector; browser HTTP success alone cannot establish the resolver path."] };
    if (!this.collector) {
      report.probes = (["http", "websocket", "worker", "webrtc", "dns", "ipv6"] as const).map(channel => untested(channel, "Owned collector is not configured"));
      await this.store.write(`egress-diagnostics/${sessionId}.json`, report); return report;
    }
    const origin = new URL(this.collector); if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password) throw new FleetError("invalid_collector", "Configured collector must be an HTTP(S) origin without credentials", 503);
    report.collectorOrigin = origin.origin;
    const page = await session!.cdpService.createPage();
    try {
      await page.goto(`${origin.origin}/?nonce=${report.id}`, { waitUntil: "domcontentloaded", timeout: 15_000 });
      const result = await page.evaluate(async ({ nonce, ipv6, stun }) => {
        const timeout = <T>(p: Promise<T>, ms = 6000): Promise<T> => new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("timeout")), ms); p.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); }); });
        const probes: any[] = [];
        const validate = (value: any) => { if (value?.nonce !== nonce || typeof value.ip !== "string") throw new Error("invalid_collector_response"); return value; };
        try { const r = await timeout(fetch(`/observe?nonce=${nonce}`, { cache: "no-store", credentials: "omit" }).then(r => r.json())); const data = validate(r); const allowedHeaders = ["user-agent", "accept-language", "sec-ch-ua", "sec-ch-ua-platform", "sec-ch-ua-mobile", "sec-ch-ua-full-version-list", "sec-ch-ua-platform-version", "sec-ch-ua-model", "sec-ch-ua-arch", "sec-ch-ua-bitness"]; const headers = Object.fromEntries(allowedHeaders.filter(name => typeof data.headers?.[name] === "string").map(name => [name, data.headers[name].slice(0, 1000)])); probes.push({ channel: "http", status: "pass", reason: "Collector observed the browser request", observedIp: data.ip, headers }); } catch { probes.push({ channel: "http", status: "fail", reason: "Browser HTTP collector request failed" }); }
        try {
          const data = validate(await timeout(new Promise((resolve, reject) => { const url = new URL(`/ws?nonce=${nonce}`, location.href); url.protocol = location.protocol === "https:" ? "wss:" : "ws:"; const socket = new WebSocket(url); const timer = setTimeout(() => { socket.close(); reject(new Error("timeout")); }, 5000); socket.onmessage = e => { clearTimeout(timer); socket.close(); try { resolve(JSON.parse(e.data)); } catch { reject(new Error("invalid_response")); } }; socket.onerror = () => { clearTimeout(timer); socket.close(); reject(new Error("websocket_failed")); }; })));
          probes.push({ channel: "websocket", status: "pass", reason: "Collector observed browser WebSocket handshake", observedIp: data.ip });
        } catch { probes.push({ channel: "websocket", status: "fail", reason: "Browser WebSocket collector request failed" }); }
        try {
          const data = validate(await timeout(new Promise((resolve, reject) => { const worker = new Worker(`/worker.js?nonce=${nonce}`); const timer = setTimeout(() => { worker.terminate(); reject(new Error("timeout")); }, 5000); worker.onmessage = e => { clearTimeout(timer); worker.terminate(); e.data.error ? reject(new Error("worker_failed")) : resolve(e.data); }; worker.onerror = () => { clearTimeout(timer); worker.terminate(); reject(new Error("worker_failed")); }; })));
          probes.push({ channel: "worker", status: "pass", reason: "Dedicated worker HTTP request reached collector", observedIp: data.ip });
        } catch { probes.push({ channel: "worker", status: "fail", reason: "Worker collector request failed" }); }
        if (!stun) probes.push({ channel: "webrtc", status: "untested", reason: "Owned STUN collector is not configured; local candidates do not prove public WebRTC egress" });
        else {
          const candidates: string[] = []; let pc: RTCPeerConnection | undefined;
          try {
            pc = new RTCPeerConnection({ iceServers: [{ urls: stun }] }); pc.createDataChannel("steel-diagnostics"); pc.onicecandidate = event => { if (event.candidate) candidates.push(event.candidate.candidate); };
            await pc.setLocalDescription(await pc.createOffer()); await timeout(new Promise<void>(resolve => { pc!.onicegatheringstatechange = () => { if (pc!.iceGatheringState === "complete") resolve(); }; }), 4000).catch(() => {});
            const reflexive = candidates.filter(candidate => /\btyp srflx\b/.test(candidate));
            probes.push({ channel: "webrtc", status: reflexive.length ? "pass" : "untested", reason: reflexive.length ? "Owned STUN server produced server-reflexive candidates; compare these observed addresses with the selected route" : "No server-reflexive STUN response was observed; this does not prove WebRTC traffic cannot leak", candidates });
          } catch { probes.push({ channel: "webrtc", status: "fail", reason: "WebRTC probe unavailable or failed" }); } finally { pc?.close(); }
        }
        if (!ipv6) probes.push({ channel: "ipv6", status: "untested", reason: "IPv6-only owned collector is not configured" });
        else try { const data = validate(await timeout(fetch(`${ipv6}/observe?nonce=${nonce}`, { credentials: "omit", cache: "no-store" }).then(r => r.json()))); probes.push({ channel: "ipv6", status: data.family === 6 ? "pass" : "fail", reason: data.family === 6 ? "IPv6 collector observed browser egress" : "Collector request did not arrive over IPv6", observedIp: data.ip }); } catch { probes.push({ channel: "ipv6", status: "fail", reason: "IPv6-only collector request failed" }); }
        return probes;
      }, { nonce: report.id, ipv6: this.ipv6Collector, stun: this.stun });
      report.probes = result as EgressProbe[];
      report.probes.push(await browserDnsProbe(page));
      const httpIp = report.probes.find(probe => probe.channel === "http" && probe.status === "pass")?.observedIp;
      if (httpIp) for (const probe of report.probes) {
        if (["websocket", "worker"].includes(probe.channel) && probe.status === "pass" && probe.observedIp !== httpIp) { probe.status = "fail"; probe.reason = "This channel exited through a different public IP from the browser HTTP request"; }
        if (probe.channel === "webrtc" && probe.status === "pass" && probe.candidates?.some(candidate => /\btyp srflx\b/.test(candidate) && candidate.split(" ")[4] !== httpIp)) { probe.status = "fail"; probe.reason = "A server-reflexive WebRTC candidate differs from the observed HTTP exit IP"; }
      }
    } catch { report.probes = (["http", "websocket", "worker", "webrtc", "dns", "ipv6"] as const).map(channel => ({ channel, status: "untested", reason: "Owned diagnostic page could not be loaded through this session" })); }
    finally { await page.close().catch(() => {}); }
    await this.store.write(`egress-diagnostics/${sessionId}.json`, report); return report;
  }
}
