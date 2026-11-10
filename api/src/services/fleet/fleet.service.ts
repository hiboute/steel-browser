import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { PlatformStore } from "../platform/store.js";
import { FleetError, type Engine, type FleetCommand, type FleetCommandName, type FleetSession, type PortableCheckpoint, type WorkerCapabilities, type WorkerRecord } from "./types.js";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
interface Pairing { hash: string; expiresAt: number; label: string; location: string; profileScope: string; engines: Engine[] }
interface State { version: 1; workers: WorkerRecord[]; sessions: FleetSession[]; commands: FleetCommand[]; pairings: Pairing[]; checkpoints: PortableCheckpoint[] }
const fresh = (): State => ({ version: 1, workers: [], sessions: [], commands: [], pairings: [], checkpoints: [] });

/** Single coordinator, durable command journal, outbound worker polling. A claimed mutation is never replayed after worker loss. */
export class FleetService {
  private state: State = fresh();
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly store: PlatformStore, private readonly now = Date.now, readonly workerTimeoutMs = 45_000) {}
  async initialize() {
    this.state = await this.store.read<State>("fleet/state.json") ?? fresh();
    if (this.state.version !== 1) throw new FleetError("fleet_version", "Unsupported fleet state version", 503);
    // An old coordinator cannot know whether an in-flight browser mutation was applied.
    for (const command of this.state.commands) if (command.state === "running") { command.state = "uncertain"; command.error = "coordinator_restarted"; }
    for (const session of this.state.sessions) if (["live", "launching", "closing"].includes(session.state)) session.state = "uncertain";
    await this.save();
  }
  private async serial<T>(action: () => Promise<T>): Promise<T> {
    const task = this.pending.catch(() => {}).then(action); this.pending = task; return task;
  }
  private save() { return this.store.write("fleet/state.json", this.state); }
  private healthy(worker: Pick<WorkerRecord, "revoked" | "lastSeen">) { return !worker.revoked && this.now() - worker.lastSeen < this.workerTimeoutMs; }
  private worker(id: string) { const worker = this.state.workers.find(w => w.id === id); if (!worker) throw new FleetError("worker_not_found", "Worker not found", 404); return worker; }
  private authenticate(id: string, token: string) { const worker = this.worker(id); if (worker.revoked || !equal(worker.tokenHash, hash(token))) throw new FleetError("invalid_worker_token", "Worker authentication failed", 401); return worker; }
  listWorkers() { return this.state.workers.map(({ tokenHash: _, ...worker }) => ({ ...worker, healthy: this.healthy(worker), activeSessions: this.state.sessions.filter(s => s.workerId === worker.id && s.state !== "closed").length })); }
  listSessions(ownerId?: string) { return structuredClone(this.state.sessions.filter(s => !ownerId || s.ownerId === ownerId)); }
  getSession(id: string) { const session = this.state.sessions.find(s => s.id === id); if (!session) throw new FleetError("fleet_session_not_found", "Fleet session not found", 404); return structuredClone(session); }
  listCheckpoints(ownerId?: string) { return this.state.checkpoints.filter(c => !ownerId || c.ownerId === ownerId).map(({ state: _, ...c }) => c); }
  async pair(input: Omit<Pairing, "hash" | "expiresAt" | "profileScope"> & { profileScope?: string }) {
    return this.serial(async () => {
      const token = randomBytes(32).toString("base64url"), expiresAt = this.now() + 600_000;
      const profileScope = input.profileScope ?? randomUUID();
      this.state.pairings = this.state.pairings.filter(p => p.expiresAt > this.now());
      this.state.pairings.push({ ...input, profileScope, hash: hash(token), expiresAt }); await this.save();
      return { token, expiresAt: new Date(expiresAt).toISOString(), profileScope };
    });
  }
  async register(token: string, capabilities: WorkerCapabilities) {
    return this.serial(async () => {
      const pairing = this.state.pairings.find(p => equal(p.hash, hash(token)) && p.expiresAt > this.now());
      if (!pairing) throw new FleetError("invalid_pairing", "Pairing expired or already used", 401);
      if (capabilities.protocol !== 1 || !capabilities.engines.length || capabilities.engines.some(e => !pairing.engines.includes(e))) throw new FleetError("worker_capability_mismatch", "Worker engines exceed the approved pairing scope", 400);
      const workerToken = randomBytes(32).toString("base64url");
      const worker: WorkerRecord = { id: randomUUID(), label: pairing.label, location: pairing.location, profileScope: pairing.profileScope, tokenHash: hash(workerToken), generation: 1, revoked: false, draining: false, lastSeen: this.now(), capabilities };
      this.state.pairings = this.state.pairings.filter(p => p !== pairing); this.state.workers.push(worker); await this.save();
      return { workerId: worker.id, token: workerToken, generation: worker.generation, profileScope: worker.profileScope };
    });
  }
  async setWorker(id: string, action: "drain" | "resume" | "revoke") {
    return this.serial(async () => {
      const worker = this.worker(id);
      if (action === "revoke") { worker.revoked = true; worker.generation++; }
      else worker.draining = action === "drain";
      if (action === "revoke") for (const session of this.state.sessions.filter(s => s.workerId === id && s.state !== "closed")) session.state = "uncertain";
      await this.save(); return this.listWorkers().find(w => w.id === id)!;
    });
  }
  async createSession(input: { ownerId: string; engine: Engine; workerId?: string; location?: string; egressPolicy?: "standard" | "strict"; checkpointId?: string; headless?: boolean }) {
    return this.serial(async () => {
      const checkpoint = input.checkpointId ? this.state.checkpoints.find(c => c.id === input.checkpointId && c.ownerId === input.ownerId) : undefined;
      if (input.checkpointId && !checkpoint) throw new FleetError("checkpoint_not_found", "Checkpoint not found", 404);
      if (checkpoint && checkpoint.engine !== input.engine) throw new FleetError("checkpoint_engine_mismatch", "Portable checkpoints currently require the same engine", 400);
      const worker = this.state.workers.filter(w => this.healthy(w) && !w.draining && w.capabilities.engines.includes(input.engine) && w.capabilities.commands.includes("launch") && (!input.workerId || w.id === input.workerId) && (!input.location || w.location === input.location) && (input.egressPolicy !== "strict" || w.capabilities.strictEgress) && this.state.sessions.filter(s => s.workerId === w.id && s.state !== "closed").length < w.capabilities.capacity).sort((a, b) => this.state.sessions.filter(s => s.workerId === a.id && s.state !== "closed").length - this.state.sessions.filter(s => s.workerId === b.id && s.state !== "closed").length)[0];
      if (!worker) throw new FleetError("fleet_capacity", "No healthy worker satisfies the requested engine, location, capacity and egress policy", 503);
      const session: FleetSession = { id: randomUUID(), ownerId: input.ownerId, workerId: worker.id, engine: input.engine, state: "launching", createdAt: new Date(this.now()).toISOString(), profileScope: worker.profileScope, egressPolicy: input.egressPolicy ?? "standard", sourceCheckpointId: checkpoint?.id };
      this.state.sessions.push(session);
      const command = this.enqueue(session, "launch", { engine: session.engine, headless: input.headless ?? worker.capabilities.device.headless, egressPolicy: session.egressPolicy, checkpoint: checkpoint?.state }, "launch");
      await this.save(); return { session: structuredClone(session), command: structuredClone(command) };
    });
  }
  private enqueue(session: FleetSession, kind: FleetCommandName, payload: Record<string, unknown>, idempotencyKey: string) {
    const existing = this.state.commands.find(c => c.sessionId === session.id && c.idempotencyKey === idempotencyKey);
    if (existing) { if (existing.kind !== kind || JSON.stringify(existing.payload) !== JSON.stringify(payload)) throw new FleetError("idempotency_conflict", "Idempotency key already has different content"); return existing; }
    const worker = this.worker(session.workerId);
    if (!this.healthy(worker)) throw new FleetError("worker_unavailable", "Worker is unavailable; no fallback or mutation replay is allowed", 503);
    if (!worker.capabilities.commands.includes(kind)) throw new FleetError("unsupported_capability", `Worker does not support ${kind}`, 422);
    const command: FleetCommand = { id: randomUUID(), sessionId: session.id, workerId: worker.id, generation: worker.generation, kind, payload, idempotencyKey, state: "queued", createdAt: new Date(this.now()).toISOString() };
    this.state.commands.push(command); return command;
  }
  async command(id: string, kind: FleetCommandName, payload: Record<string, unknown>, idempotencyKey: string) {
    return this.serial(async () => {
      const session = this.state.sessions.find(s => s.id === id); if (!session) throw new FleetError("fleet_session_not_found", "Fleet session not found", 404);
      const prior = this.state.commands.find(c => c.sessionId === id && c.idempotencyKey === idempotencyKey);
      if (!prior && session.state !== "live" && kind !== "close") throw new FleetError("session_not_ready", "Session must be live before commands can execute");
      const command = this.enqueue(session, kind, payload, idempotencyKey); if (kind === "close") session.state = "closing";
      await this.save(); return structuredClone(command);
    });
  }
  getCommand(sessionId: string, id: string) { const command = this.state.commands.find(c => c.sessionId === sessionId && c.id === id); if (!command) throw new FleetError("command_not_found", "Command not found", 404); return structuredClone(command); }
  async poll(id: string, token: string, liveSessionIds: string[]) {
    return this.serial(async () => {
      const worker = this.authenticate(id, token); worker.lastSeen = this.now();
      // Reconcile presence, not the outcome of an uncertain external mutation.
      for (const session of this.state.sessions.filter(s => s.workerId === id)) {
        if (session.state === "uncertain" && liveSessionIds.includes(session.id) && !this.state.commands.some(c => c.sessionId === session.id && c.state === "uncertain")) session.state = "live";
        if (session.state === "live" && !liveSessionIds.includes(session.id)) { session.state = "uncertain"; session.lastError = "worker_lost_browser"; }
      }
      for (const command of this.state.commands.filter(c => c.workerId === id && c.state === "running" && (c.claimedAt ?? 0) + 120_000 < this.now())) { command.state = "uncertain"; command.error = "worker_command_timed_out"; const s = this.state.sessions.find(s => s.id === command.sessionId); if (s) s.state = "uncertain"; }
      const running = new Set(this.state.commands.filter(c => c.workerId === id && c.state === "running").map(c => c.sessionId));
      const commands: FleetCommand[] = [];
      for (const command of this.state.commands.filter(c => c.workerId === id && c.state === "queued" && c.generation === worker.generation)) {
        if (running.has(command.sessionId)) continue;
        command.state = "running"; command.claimedAt = this.now(); running.add(command.sessionId); commands.push(structuredClone(command));
      }
      await this.save(); return { generation: worker.generation, revoked: false, commands };
    });
  }
  async complete(id: string, token: string, commandId: string, generation: number, outcome: { result?: unknown; error?: string }) {
    return this.serial(async () => {
      const worker = this.authenticate(id, token); const command = this.state.commands.find(c => c.id === commandId && c.workerId === id);
      if (!command || generation !== worker.generation || command.generation !== generation) throw new FleetError("stale_worker_generation", "Worker command generation is stale", 409);
      if (command.state === "completed" || command.state === "failed") return { accepted: true };
      if (command.state !== "running") throw new FleetError("command_uncertain", "Command requires explicit reconciliation; late result was not applied");
      const session = this.state.sessions.find(s => s.id === command.sessionId)!;
      command.state = outcome.error ? "failed" : "completed"; command.result = outcome.result; command.error = outcome.error?.slice(0, 200);
      if (command.kind === "launch") { session.state = outcome.error ? "closed" : "live"; session.lastError = command.error; const version = (outcome.result as any)?.browserVersion; if (!outcome.error && typeof version === "string") worker.capabilities.browserVersions[session.engine] = version.slice(0, 100); }
      if (command.kind === "close") session.state = outcome.error ? "uncertain" : "closed";
      if (command.kind === "checkpoint" && !outcome.error) {
        const state = outcome.result as PortableCheckpoint["state"];
        if (!state || !Array.isArray(state.tabs) || !state.storageState) throw new FleetError("invalid_checkpoint", "Worker checkpoint is invalid", 400);
        const checkpoint: PortableCheckpoint = { id: randomUUID(), sessionId: session.id, ownerId: session.ownerId, engine: session.engine, createdAt: new Date(this.now()).toISOString(), state };
        this.state.checkpoints.push(checkpoint); command.result = { checkpointId: checkpoint.id, semantics: "portable_web_state" };
      }
      worker.lastSeen = this.now(); await this.save(); return { accepted: true };
    });
  }
  async reconcile(sessionId: string, commandId: string, decision: "applied" | "not_applied", result?: unknown) {
    return this.serial(async () => {
      const command = this.state.commands.find(c => c.sessionId === sessionId && c.id === commandId && c.state === "uncertain");
      if (!command) throw new FleetError("not_uncertain", "Command is not awaiting reconciliation");
      command.state = decision === "applied" ? "completed" : "failed"; command.result = result; command.error = decision === "not_applied" ? "operator_confirmed_not_applied" : undefined;
      await this.save(); return structuredClone(command);
    });
  }
  async close() { await this.pending; await this.store.flush(); }
}
