import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PlatformStore } from "../platform/store.js";
import { FleetService } from "./fleet.service.js";
import type { WorkerCapabilities } from "./types.js";
const capabilities: WorkerCapabilities = { protocol: 1, engines: ["chromium", "firefox"], commands: ["launch", "goto", "snapshot", "checkpoint", "close"], capacity: 2, device: { kind: "desktop", os: "linux", graphics: "unknown", headless: true }, strictEgress: false, browserVersions: {} };
const roots: string[] = [];
async function setup() { const root = await mkdtemp(path.join(os.tmpdir(), "steel-fleet-")); roots.push(root); let now = Date.now(); const store = new PlatformStore(root, "test-key"); const fleet = new FleetService(store, () => now); await fleet.initialize(); return { fleet, store, advance: (ms: number) => { now += ms; } }; }
async function worker(fleet: FleetService, overrides = {}) { const pairing = await fleet.pair({ label: "Test", location: "home", engines: ["chromium", "firefox"] }); return fleet.register(pairing.token, { ...capabilities, ...overrides }); }
async function live(fleet: FleetService, w: Awaited<ReturnType<typeof worker>>, options = {}) { const result = await fleet.createSession({ ownerId: "alice", engine: "chromium", ...options }); await fleet.poll(w.workerId, w.token, []); await fleet.complete(w.workerId, w.token, result.command.id, w.generation, { result: { launched: true } }); return result.session; }
afterEach(async () => { await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true }))); });
describe("fleet durable coordination", () => {
  it("consumes pairings once, validates scope and never returns token hashes", async () => {
    const { fleet } = await setup(); const pairing = await fleet.pair({ label: "Mac", location: "home", engines: ["chromium"] });
    await expect(fleet.register(pairing.token, capabilities)).rejects.toMatchObject({ code: "worker_capability_mismatch" });
    await fleet.register(pairing.token, { ...capabilities, engines: ["chromium"] });
    await expect(fleet.register(pairing.token, capabilities)).rejects.toMatchObject({ code: "invalid_pairing" });
    expect(JSON.stringify(fleet.listWorkers())).not.toContain("tokenHash");
  });
  it("expires pairings and fences revoked workers", async () => {
    const { fleet, advance } = await setup(); const pairing = await fleet.pair({ label: "a", location: "home", engines: ["chromium"] }); advance(600_001);
    await expect(fleet.register(pairing.token, capabilities)).rejects.toMatchObject({ code: "invalid_pairing" });
    const w = await worker(fleet); await fleet.setWorker(w.workerId, "revoke"); await expect(fleet.poll(w.workerId, w.token, [])).rejects.toMatchObject({ code: "invalid_worker_token" });
  });
  it("routes sticky sessions, enforces capabilities and rejects strict placement without a boundary", async () => {
    const { fleet } = await setup(); const w = await worker(fleet); const session = await live(fleet, w);
    expect(session.workerId).toBe(w.workerId);
    await expect(fleet.createSession({ ownerId: "alice", engine: "safari" })).rejects.toMatchObject({ code: "fleet_capacity" });
    await expect(fleet.createSession({ ownerId: "alice", engine: "chromium", egressPolicy: "strict" })).rejects.toMatchObject({ code: "fleet_capacity" });
    await expect(fleet.command(session.id, "fill", {}, "fill-1")).rejects.toMatchObject({ code: "unsupported_capability" });
    await fleet.setWorker(w.workerId, "drain"); await expect(fleet.createSession({ ownerId: "alice", engine: "chromium" })).rejects.toMatchObject({ code: "fleet_capacity" });
    expect((await fleet.command(session.id, "snapshot", {}, "snapshot-1")).state).toBe("queued");
  });
  it("serializes command dispatch per session and protects idempotency content", async () => {
    const { fleet } = await setup(); const w = await worker(fleet); const s = await live(fleet, w);
    const first = await fleet.command(s.id, "goto", { url: "https://example.org" }, "go"); const same = await fleet.command(s.id, "goto", { url: "https://example.org" }, "go"); expect(first.id).toBe(same.id);
    await expect(fleet.command(s.id, "goto", { url: "https://other.org" }, "go")).rejects.toMatchObject({ code: "idempotency_conflict" });
    await fleet.command(s.id, "snapshot", {}, "snapshot"); expect((await fleet.poll(w.workerId, w.token, [s.id])).commands).toHaveLength(1);
    expect((await fleet.poll(w.workerId, w.token, [s.id])).commands).toHaveLength(0);
    await fleet.complete(w.workerId, w.token, first.id, w.generation, { result: true }); expect((await fleet.poll(w.workerId, w.token, [s.id])).commands).toHaveLength(1);
  });
  it("never blindly retries mutations across a coordinator restart", async () => {
    const { fleet, store } = await setup(); const w = await worker(fleet); const s = await live(fleet, w);
    const command = await fleet.command(s.id, "goto", { url: "https://example.org/submit" }, "mutation"); await fleet.poll(w.workerId, w.token, [s.id]);
    const restarted = new FleetService(store); await restarted.initialize(); expect(restarted.getCommand(s.id, command.id).state).toBe("uncertain");
    expect((await restarted.poll(w.workerId, w.token, [s.id])).commands).toHaveLength(0); expect(restarted.getSession(s.id).state).toBe("uncertain");
    expect(await restarted.complete(w.workerId, w.token, command.id, w.generation, { result: true })).toEqual({ accepted: true, uncertain: true });
    expect(restarted.getCommand(s.id, command.id).state).toBe("uncertain");
    await restarted.reconcile(s.id, command.id, "applied", { verified: true }); await restarted.poll(w.workerId, w.token, [s.id]); expect(restarted.getSession(s.id).state).toBe("live");
  });
  it("branches portable state only for the owning client and matching engine", async () => {
    const { fleet } = await setup(); const w = await worker(fleet); const s = await live(fleet, w); const command = await fleet.command(s.id, "checkpoint", {}, "checkpoint"); await fleet.poll(w.workerId, w.token, [s.id]);
    await fleet.complete(w.workerId, w.token, command.id, w.generation, { result: { storageState: { cookies: [], origins: [] }, tabs: [{ url: "https://example.org" }] } });
    const checkpointId = (fleet.getCommand(s.id, command.id).result as any).checkpointId;
    await expect(fleet.createSession({ ownerId: "bob", engine: "chromium", checkpointId })).rejects.toMatchObject({ code: "checkpoint_not_found" });
    await expect(fleet.createSession({ ownerId: "alice", engine: "firefox", checkpointId })).rejects.toMatchObject({ code: "checkpoint_engine_mismatch" });
    const branch = await fleet.createSession({ ownerId: "alice", engine: "chromium", checkpointId }); expect(branch.session.id).not.toBe(s.id); expect(branch.command.payload.checkpoint).toMatchObject({ tabs: [{ url: "https://example.org" }] });
  });
  it("marks hung commands uncertain and never falls back to another worker", async () => {
    const { fleet, advance } = await setup(); const w = await worker(fleet); const s = await live(fleet, w); const c = await fleet.command(s.id, "goto", { url: "https://example.org" }, "go"); await fleet.poll(w.workerId, w.token, [s.id]); advance(120_001); await fleet.poll(w.workerId, w.token, [s.id]); expect(fleet.getCommand(s.id, c.id).state).toBe("uncertain");
    advance(45_001); await expect(fleet.command(s.id, "close", {}, "close")).rejects.toMatchObject({ code: "worker_unavailable" });
  });
  it("fences queued and in-flight commands when human control changes", async () => {
    const { store } = await setup(); let generation = 1; const fleet = new FleetService(store, Date.now, 45_000, (_id, current) => current === generation); await fleet.initialize(); const w = await worker(fleet); const s = await live(fleet, w);
    const queued = await fleet.command(s.id, "snapshot", {}, "queued", 1); generation = 2; expect((await fleet.poll(w.workerId, w.token, [s.id])).commands).toHaveLength(0); expect(fleet.getCommand(s.id, queued.id).state).toBe("failed");
    const running = await fleet.command(s.id, "goto", { url: "https://example.org" }, "running", 2); await fleet.poll(w.workerId, w.token, [s.id]); generation = 3; const poll = await fleet.poll(w.workerId, w.token, [s.id]); expect(poll.fencedSessionIds).toEqual([s.id]); expect(fleet.getCommand(s.id, running.id).state).toBe("uncertain");
    expect(await fleet.complete(w.workerId, w.token, running.id, w.generation, { result: true })).toEqual({ accepted: true, uncertain: true });
  });
});
