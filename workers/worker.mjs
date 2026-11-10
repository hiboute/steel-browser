#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { commands, createAdapter } from "./adapters.mjs";

export class BrowserWorker {
  constructor(options) { this.options = options; this.sessions = new Map(); this.running = new Map(); this.results = new Map(); this.stopped = false; }
  async request(route, body, token = this.credentials?.token) {
    const response = await fetch(this.options.coordinator + "/v1/fleet/worker" + route, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    if (response.status === 401 || response.status === 403) { const error = new Error("worker_revoked_or_unauthorized"); error.fatal = true; throw error; }
    if (!response.ok) throw new Error(`coordinator_status_${response.status}`); return response.json();
  }
  async initialize() {
    await mkdir(this.options.stateRoot, { recursive: true, mode: 0o700 });
    const credentialsFile = path.join(this.options.stateRoot, "credentials.json");
    try { this.credentials = JSON.parse(await readFile(credentialsFile, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!this.credentials) {
      if (!this.options.pairingToken) throw new Error("pairing_token_required");
      this.credentials = await this.request("/register", { pairingToken: this.options.pairingToken, capabilities: this.options.capabilities });
      await writeFile(credentialsFile + ".tmp", JSON.stringify(this.credentials), { mode: 0o600 }); await rename(credentialsFile + ".tmp", credentialsFile);
    }
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(this.credentials.profileScope)) throw new Error("invalid_profile_scope");
    this.profileRoot = path.join(this.options.stateRoot, "profiles", this.credentials.profileScope); await mkdir(this.profileRoot, { recursive: true, mode: 0o700 });
  }
  async execute(command) {
    let result, error;
    try {
      if (command.generation !== this.credentials.generation) throw new Error("stale_worker_generation");
      if (command.kind === "launch") {
        if (this.sessions.size >= this.options.capabilities.capacity) throw new Error("worker_capacity");
        if (!this.options.capabilities.engines.includes(command.payload.engine)) throw new Error("unsupported_engine");
        if (command.payload.egressPolicy === "strict" && !this.options.capabilities.strictEgress) throw new Error("strict_boundary_unavailable");
        const adapter = (this.options.adapterFactory ?? createAdapter)(command.payload.engine, { ...this.options.adapter, profileRoot: this.profileRoot, strict: this.options.capabilities.strictEgress });
        try { result = await adapter.launch(command.sessionId, command.payload); this.sessions.set(command.sessionId, adapter); } catch (e) { await adapter.close().catch(() => {}); throw e; }
      } else {
        const adapter = this.sessions.get(command.sessionId); if (!adapter) throw new Error("browser_not_available");
        result = await adapter.execute(command.kind, command.payload); if (command.kind === "close") this.sessions.delete(command.sessionId);
      }
    } catch (e) { /* Never serialize engine errors: they can include typed values, URLs or proxy credentials. */ error = /^[a-z_]{1,80}$/.test(e.message) ? e.message : "browser_command_failed"; }
    this.results.set(command.id, { generation: command.generation, result, error });
  }
  async tick() {
    for (const [id, result] of this.results) { await this.request(`/${this.credentials.workerId}/commands/${id}/result`, result); this.results.delete(id); }
    const response = await this.request(`/${this.credentials.workerId}/poll`, { liveSessionIds: [...this.sessions.keys()] });
    if (response.revoked || response.generation !== this.credentials.generation) throw Object.assign(new Error("worker_revoked_or_fenced"), { fatal: true });
    for (const sessionId of response.fencedSessionIds ?? []) { const adapter = this.sessions.get(sessionId); if (adapter) { await adapter.close().catch(() => {}); this.sessions.delete(sessionId); } }
    for (const command of response.commands) {
      if (this.running.has(command.id) || this.results.has(command.id)) continue;
      const task = this.execute(command).finally(() => this.running.delete(command.id)); this.running.set(command.id, task);
    }
  }
  async run() {
    await this.initialize(); let failures = 0;
    while (!this.stopped) {
      try { await this.tick(); failures = 0; } catch (error) { failures++; if (error.fatal) { await this.close(); throw error; } }
      // Losing the coordinator freezes control; prolonged loss closes dedicated browsers.
      if (failures > 30) { await this.close(); throw new Error("coordinator_unavailable"); }
      await delay(Math.min(1000 * Math.max(1, failures), 10_000));
    }
  }
  async close() { this.stopped = true; await Promise.allSettled([...this.running.values()]); await Promise.allSettled([...this.sessions.values()].map(adapter => adapter.close())); this.sessions.clear(); }
}

export async function fromEnvironment() {
  const coordinator = new URL(process.env.STEEL_WORKER_COORDINATOR ?? "http://127.0.0.1:3000");
  if (coordinator.protocol !== "https:" && !["127.0.0.1", "localhost", "steel-api"].includes(coordinator.hostname) && process.env.STEEL_WORKER_PRIVATE_HTTP !== "true") throw new Error("coordinator_requires_https_or_explicit_private_network");
  if (coordinator.username || coordinator.password || coordinator.pathname !== "/") throw new Error("invalid_coordinator_origin");
  const engines = (process.env.STEEL_WORKER_ENGINES ?? "chromium").split(",");
  if (engines.some(e => !["chromium", "firefox", "webkit", "safari", "android"].includes(e))) throw new Error("invalid_engine");
  const stateRoot = path.resolve(process.env.STEEL_WORKER_STATE_DIR ?? path.join(os.homedir(), ".local/state/steel-worker"));
  if ([os.homedir(), path.join(os.homedir(), "Library/Application Support/Google/Chrome")].includes(stateRoot)) throw new Error("dedicated_state_directory_required");
  let strictEgress = false;
  let proxy;
  if (process.env.STEEL_WORKER_PROXY_URL) { const endpoint = new URL(process.env.STEEL_WORKER_PROXY_URL); proxy = { server: `${endpoint.protocol}//${endpoint.hostname}:${endpoint.port || "80"}`, username: decodeURIComponent(endpoint.username), password: decodeURIComponent(endpoint.password), bypass: "<-loopback>" }; }
  if (process.env.STEEL_WORKER_STRICT === "true") {
    const filename = "/run/steel/strict-egress.json", info = await stat(filename), boundary = JSON.parse(await readFile(filename, "utf8"));
    if (info.uid !== 0 || info.mode & 0o022 || boundary.uid !== process.getuid?.() || boundary.uid === 0 || boundary.boundary !== "linux-output-firewall" || boundary.ipv6 !== "blocked" || boundary.dns !== "blocked" || !proxy || new URL(proxy.server).hostname !== boundary.proxyHost || Number(new URL(proxy.server).port) !== boundary.proxyPort) throw new Error("strict_boundary_unavailable"); strictEgress = true;
  }
  const headless = process.env.STEEL_WORKER_HEADLESS !== "false";
  const capacity = Number(process.env.STEEL_WORKER_CAPACITY ?? "1"); if (!Number.isInteger(capacity) || capacity < 1 || capacity > 16) throw new Error("invalid_capacity");
  if ((engines.includes("safari") || engines.includes("android")) && capacity !== 1) throw new Error("device_capacity_must_be_one");
  return new BrowserWorker({ coordinator: coordinator.origin, stateRoot, pairingToken: process.env.STEEL_WORKER_PAIRING_TOKEN, capabilities: { protocol: 1, engines, commands, capacity, device: { kind: engines.includes("android") ? "android" : "desktop", os: `${os.platform()} ${os.release()} ${os.arch()}`, graphics: "unknown", headless }, strictEgress, browserVersions: {} }, adapter: { proxy, headless, channel: process.env.STEEL_WORKER_CHROME_CHANNEL, executablePath: process.env.STEEL_WORKER_CHROME_PATH, androidSerial: process.env.STEEL_WORKER_ANDROID_SERIAL } });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const worker = await fromEnvironment(); for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void worker.close());
  worker.run().catch(error => { process.stderr.write(`Steel worker stopped: ${/^[a-z_]+$/.test(error.message) ? error.message : "worker_failed"}\n`); process.exitCode = 1; });
}
