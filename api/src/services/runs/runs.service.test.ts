import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PlatformStore } from "../platform/store.js";
import { OwnershipService } from "../control/ownership.js";
import { RunService } from "./runs.service.js";
import type { Actor } from "../control/access.js";
import type { Run } from "./types.js";
let root: string,
  store: PlatformStore,
  control: OwnershipService,
  runs: RunService,
  sessions: any,
  commands: any;
const actor: Actor = { id: "agent", role: "agent", authenticated: true };
const step = { id: "one", kind: "test", input: {} };
async function settled(id: string, status: string) {
  await vi.waitFor(() => expect(runs.get(id, actor).status).toBe(status));
  return runs.get(id, actor);
}
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "steel-runs-"));
  store = new PlatformStore(root);
  control = new OwnershipService(store);
  await control.initialize();
  await control.registerResource("s", actor.id);
  sessions = {
    isParked: () => false,
    getSession: (id: string) => ({ id, status: "live" }),
    holdActivity: () => () => {},
    startSession: vi.fn(async () => ({ id: "s" })),
  };
  commands = {
    reset: vi.fn(),
    get: vi.fn(() => ({
      handle: vi.fn(async () => ({
        status: 200,
        body: { execution: { state: "completed" }, results: [{ ok: true }] },
      })),
    })),
  };
  runs = new RunService(store, sessions, commands, control, () => {});
});
afterEach(async () => {
  await runs.close();
  await control.close();
  await rm(root, { recursive: true, force: true });
});
describe("durable task runs", () => {
  it("retries safe failures but never automatically repeats ambiguous external mutation", async () => {
    const safe = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue({ status: "succeeded" });
    runs.registerKind("test", { validate: (x) => x, replay: "safe", execute: safe });
    const a = await runs.create(
      { sessionId: "s", steps: [{ ...step, retry: { maxAttempts: 2, delayMs: 0 } }] },
      actor,
    );
    await settled(a.id, "completed");
    expect(safe).toHaveBeenCalledTimes(2);
    const ambiguous = vi.fn(async () => {
      throw new Error("maybe submitted");
    });
    runs.registerKind("mutation", { validate: (x) => x, replay: "ambiguous", execute: ambiguous });
    const b = await runs.create(
      {
        sessionId: "s",
        steps: [{ ...step, kind: "mutation", retry: { maxAttempts: 5, delayMs: 0 } }],
      },
      actor,
    );
    await settled(b.id, "uncertain");
    expect(ambiguous).toHaveBeenCalledTimes(1);
    await expect(runs.resume(b.id, actor)).rejects.toMatchObject({
      code: "reconciliation_required",
    });
    await runs.resume(b.id, actor, {
      resolution: { stepId: "one", outcome: "applied", evidence: "Receipt 123 verified" },
    });
    await settled(b.id, "completed");
    expect(ambiguous).toHaveBeenCalledTimes(1);
  });
  it("reenters waiting extension steps on an explicit resume", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        status: "paused",
        reason: "review_required",
        output: { reviewId: "review" },
      })
      .mockResolvedValueOnce({ status: "succeeded" });
    runs.registerKind("test", { validate: (x) => x, replay: "safe", execute });
    const r = await runs.create({ sessionId: "s", steps: [step] }, actor);
    await settled(r.id, "paused");
    await runs.resume(r.id, actor);
    await settled(r.id, "completed");
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it("requires explicit lease delegation and fences the prior human token", async () => {
    const old = await control.acquire("s", actor, { mode: "human" });
    runs.registerKind("test", {
      validate: (x) => x,
      replay: "safe",
      execute: async () => ({ status: "succeeded" }),
    });
    const r = await runs.create({ sessionId: "s", controlToken: old.token, steps: [step] }, actor);
    await settled(r.id, "completed");
    expect(() => control.assert("s", actor, old.token)).toThrow();
    expect(JSON.stringify(await store.read(`runs/${r.id}.json`))).not.toContain(old.token);
  });
  it("refuses internal launch fields and detects idempotency payload changes", async () => {
    runs.registerKind("test", {
      validate: (x) => x,
      replay: "safe",
      execute: async () => ({ status: "paused" }),
    });
    for (const sessionOptions of [
      { _principal: { id: "operator" } },
      { userDataDir: "/host/private" },
      { extra: ["--dangerous"] },
      { privateCapture: false },
    ])
      await expect(runs.create({ sessionOptions, steps: [step] } as any, actor)).rejects.toThrow();
    const input = {
      sessionId: "s",
      steps: [step],
      metadata: { version: 1 },
      idempotencyKey: "same",
    };
    const r = await runs.create(input, actor);
    await settled(r.id, "paused");
    expect((await runs.create(input, actor)).id).toBe(r.id);
    await expect(runs.create({ ...input, metadata: { version: 2 } }, actor)).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
    expect(() => runs.get(r.id, { ...actor, id: "other" })).toThrow();
  });
  it("recovers in-flight ambiguous steps as uncertain and replays safe observations", async () => {
    runs.registerKind("test", {
      validate: (x) => x,
      replay: "safe",
      execute: async () => ({ status: "succeeded" }),
    });
    const now = new Date().toISOString();
    const base: Run = {
      id: "crashed",
      sessionId: "s",
      ownerId: actor.id,
      actor,
      status: "running",
      revision: 1,
      cursor: 0,
      steps: [
        {
          id: "one",
          kind: "commands",
          input: { commands: { command: "click", target: "button" } },
        },
      ],
      results: [{ stepId: "one", status: "running", attempts: 1 }],
      createdAt: now,
      updatedAt: now,
    };
    await store.write("runs/crashed.json", base);
    await store.write("runs/observing.json", { ...base, id: "observing", steps: [step] });
    await runs.initialize();
    expect(runs.get("crashed", actor).status).toBe("uncertain");
    await settled("observing", "completed");
  });
  it("bounds cancellation of an executor ignoring abort and fences its later commands", async () => {
    let ctx: any;
    let entered!: () => void;
    const barrier = new Promise<void>((r) => (entered = r));
    runs.registerKind("test", {
      validate: (x) => x,
      replay: "ambiguous",
      execute: async (c) => {
        ctx = c;
        entered();
        return new Promise(() => {});
      },
    });
    const r = await runs.create({ sessionId: "s", steps: [step] }, actor);
    await barrier;
    await runs.cancel(r.id, actor);
    expect(runs.get(r.id, actor).status).toBe("cancelled");
    expect(runs.get(r.id, actor).results[0].status).toBe("uncertain");
    await expect(
      ctx.execute({ commands: { command: "click", target: "button" } }),
    ).rejects.toThrow();
    expect(commands.get).not.toHaveBeenCalled();
  });
  it("does not expose mutable run metadata by reference", async () => {
    runs.registerKind("test", {
      validate: (x) => x,
      replay: "safe",
      execute: async () => ({ status: "paused" }),
    });
    const r = await runs.create(
      { sessionId: "s", steps: [step], metadata: { nested: { approved: false } } },
      actor,
    );
    await settled(r.id, "paused");
    (runs.get(r.id, actor).metadata!.nested as any).approved = true;
    expect((runs.get(r.id, actor).metadata!.nested as any).approved).toBe(false);
  });
});

it("defers recovered execution until all extension services are ready", async () => {
  let ready = false;
  const execute = vi.fn(async () => {
    expect(ready).toBe(true);
    return { status: "succeeded" as const };
  });
  runs.registerKind("test", { validate: (x) => x, replay: "safe", execute });
  const now = new Date().toISOString();
  await store.write("runs/recover.json", {
    id: "recover",
    sessionId: "s",
    ownerId: actor.id,
    actor,
    status: "queued",
    revision: 1,
    cursor: 0,
    steps: [step],
    results: [{ stepId: "one", status: "pending", attempts: 0 }],
    createdAt: now,
    updatedAt: now,
  });
  await runs.initialize(false);
  await new Promise((r) => setTimeout(r, 10));
  expect(execute).not.toHaveBeenCalled();
  ready = true;
  runs.startRecovered();
  await settled("recover", "completed");
});
it("does not launch a parked browser held by a human", async () => {
  sessions.isParked = () => true;
  sessions.resumeSession = vi.fn();
  await control.acquire("s", actor, { mode: "human" });
  runs.registerKind("test", {
    validate: (x) => x,
    replay: "safe",
    execute: async () => ({ status: "succeeded" }),
  });
  const r = await runs.create({ sessionId: "s", steps: [step] }, actor);
  await settled(r.id, "paused");
  expect(sessions.resumeSession).not.toHaveBeenCalled();
  expect(runs.get(r.id, actor).pauseReason).toBe("control_required");
});
it("never journals sensitive command output after vault protection", async () => {
  sessions.getLaunchOptions = () => ({ privateCapture: true });
  commands.get = () => ({
    handle: async () => ({
      status: 200,
      body: {
        execution: { state: "completed", id: "execution" },
        results: [
          { ok: true, command: "snapshot", value: "reflected-vault-value", effect: "none" },
        ],
      },
    }),
  });
  const r = await runs.create(
    {
      sessionId: "s",
      steps: [{ id: "observe", kind: "commands", input: { commands: { command: "snapshot" } } }],
    },
    actor,
  );
  await settled(r.id, "completed");
  expect(JSON.stringify(await store.read(`runs/${r.id}.json`))).not.toContain(
    "reflected-vault-value",
  );
  expect(runs.get(r.id, actor).results[0].output).toMatchObject({
    privateCapture: true,
    results: [{ ok: true, command: "snapshot", effect: "none" }],
  });
});
it("does not auto-execute a task whose explicit control delegation failed", async () => {
  const lease = await control.acquire("s", actor, { mode: "human" });
  runs.registerKind("test", { validate: (x) => x, replay: "safe", execute: vi.fn() });
  vi.spyOn(control, "transfer").mockRejectedValueOnce(new Error("fenced during save"));
  await expect(
    runs.create({ sessionId: "s", controlToken: lease.token, steps: [step] }, actor),
  ).rejects.toThrow("fenced during save");
  expect(runs.list(actor)).toMatchObject([
    { status: "paused", pauseReason: "control_delegation_pending" },
  ]);
});
