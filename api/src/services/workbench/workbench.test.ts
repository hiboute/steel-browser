import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlatformStore } from "../platform/store.js";
import type { Handoff } from "../handoff.service.js";
import type { TimelineEntry } from "../timeline.service.js";
import { WorkbenchService, redactNote } from "./workbench.service.js";
import { explainState } from "./explanation.js";
import type { KnowledgeInput, WorkbenchActor, WorkbenchAdapters, WorkSource } from "./types.js";

const actor: WorkbenchActor = { id: "alice", role: "agent", authenticated: true };
const operator: WorkbenchActor = { id: "operator", role: "operator", authenticated: true };
const now = Date.parse("2026-11-10T12:00:00Z");
const handoff: Handoff = {
  id: "h1",
  sessionId: "s1",
  status: "done",
  reason: "Confirm account",
  requestedAt: "2026-11-10T11:50:00Z",
  resolvedAt: "2026-11-10T11:55:00Z",
  expiresAt: "2026-11-10T12:20:00Z",
  requestedBy: "alice",
  resolvedBy: "alice",
  note: null,
  liveUrl: "http://localhost/?session=s1",
};
const entry: TimelineEntry = {
  seq: 1,
  at: "2026-11-10T11:52:00Z",
  client: "alice",
  kind: "action",
  tool: "browser_click",
  args: { selector: "#continue" },
  screenshot: false,
};
const knowledge: KnowledgeInput = {
  sessionId: "s1",
  handoffId: "h1",
  title: "Continue after verification",
  note: "Select Continue",
  selectedSteps: [1],
  origin: "https://example.com",
};
let root: string,
  store: PlatformStore,
  service: WorkbenchService,
  adapters: WorkbenchAdapters,
  rows: WorkSource[];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "steel-workbench-"));
  store = new PlatformStore(root, "test-encryption-key");
  rows = [
    {
      kind: "run",
      id: "r1",
      sessionId: "s1",
      ownerId: "alice",
      status: "failed",
      title: "Research",
      updatedAt: "2026-11-10T11:59:00Z",
      revision: 1,
      actions: ["retry", "open"],
    },
  ];
  adapters = {
    sources: async () => rows,
    perform: vi.fn(async (source) => {
      source.status = "running";
      source.revision = Number(source.revision) + 1;
      source.actions = ["open"];
      return { id: source.id };
    }),
    authorize: vi.fn(async () => {}),
    telemetry: async () => ({ session: { id: "s1", status: "live" }, unavailable: [] }),
    handoff: () => handoff,
    timeline: async () => [entry],
    sessionOrigin: async () => "https://example.com",
    applyRecovery: vi.fn(async () => ({ runId: "recovery-run" })),
  };
  service = new WorkbenchService(
    store,
    adapters,
    () => {},
    () => now,
  );
});
afterEach(async () => {
  await service.close();
  await rm(root, { recursive: true, force: true });
});

describe("work inbox", () => {
  it("omits inaccessible source sessions without hiding permitted work", async () => {
    rows.push({ ...rows[0], id: "denied", sessionId: "foreign" });
    adapters.authorize = async (id) => {
      if (id === "foreign") throw Object.assign(new Error("denied"), { statusCode: 403 });
    };
    expect((await service.inbox(actor)).map((item) => item.sourceId)).toEqual(["r1"]);
  });
  it("deduplicates stable IDs, scopes callers and persists read/dismiss state across restart", async () => {
    rows.push({ ...rows[0] }, { ...rows[0], id: "other", ownerId: "bob" });
    const [card] = await service.inbox(actor);
    expect(await service.inbox(actor)).toHaveLength(1);
    await service.updateCard(card.id, actor, {
      expectedRevision: card.revision,
      read: true,
      dismissed: true,
    });
    const restarted = new WorkbenchService(store, adapters);
    expect(await restarted.inbox(actor)).toEqual([]);
    expect((await restarted.inbox(actor, { includeDismissed: true }))[0].readAt).toBeTruthy();
    expect(await restarted.inbox(operator)).toHaveLength(2);
  });
  it("makes changed source state unread again and rejects old actions", async () => {
    const [card] = await service.inbox(actor);
    await service.updateCard(card.id, actor, { expectedRevision: card.revision, dismissed: true });
    rows[0].revision = 2;
    const [fresh] = await service.inbox(actor);
    expect(fresh.dismissedAt).toBeNull();
    await expect(
      service.act(card.id, actor, { expectedRevision: card.revision, action: "retry" }),
    ).rejects.toMatchObject({ code: "stale_item" });
    expect(adapters.perform).not.toHaveBeenCalled();
  });
  it("admits only one of two simultaneous retries", async () => {
    const [card] = await service.inbox(actor);
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        service.act(card.id, actor, { expectedRevision: card.revision, action: "retry" }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(adapters.perform).toHaveBeenCalledTimes(1);
  });
  it("rejects an action not available in the current state", async () => {
    const [card] = await service.inbox(actor);
    await expect(
      service.act(card.id, actor, { expectedRevision: card.revision, action: "approve" }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
  });
  it("redacts credential-shaped text and details in cards", async () => {
    rows[0].description = "password=supersecret Bearer abcdefghijkl";
    rows[0].details = { token: "private" };
    expect(JSON.stringify(await service.inbox(actor))).not.toMatch(
      /supersecret|abcdefghijkl|private/,
    );
  });
});

describe("learned recovery", () => {
  it("keeps immutable versions and requires reviewed version on edits/deletion", async () => {
    const saved = await service.createKnowledge(knowledge, actor);
    const edited = await service.updateKnowledge(saved.id, actor, {
      expectedVersion: 1,
      note: "Updated instructions",
    });
    expect(edited.version).toBe(2);
    expect((await service.knowledge(saved.id, actor, 1)).note).toBe("Select Continue");
    await expect(service.deleteKnowledge(saved.id, actor, 1)).rejects.toMatchObject({
      code: "stale_knowledge",
    });
    await service.deleteKnowledge(saved.id, actor, 2);
    expect(await service.listKnowledge(actor)).toEqual([]);
    await expect(service.knowledge(saved.id, actor, 1)).rejects.toMatchObject({
      code: "knowledge_not_found",
    });
  });
  it("rejects origins not measured on the bound browser and unresolved handoffs", async () => {
    await expect(
      service.createKnowledge({ ...knowledge, origin: "https://evil.test" }, actor),
    ).rejects.toMatchObject({ code: "origin_mismatch" });
    service.configure({ handoff: () => ({ ...handoff, status: "waiting" }) });
    await expect(service.createKnowledge(knowledge, actor)).rejects.toMatchObject({
      code: "handoff_not_resolved",
    });
  });
  it("requires deliberately selected steps from the resolution interval", async () => {
    await expect(
      service.createKnowledge({ ...knowledge, selectedSteps: [99] }, actor),
    ).rejects.toMatchObject({ code: "invalid_step" });
    service.configure({ timeline: async () => [{ ...entry, at: "2026-11-10T10:00:00Z" }] });
    await expect(service.createKnowledge(knowledge, actor)).rejects.toMatchObject({
      code: "invalid_step",
    });
  });
  it("redacts human resolution secrets and never replays captured form values", async () => {
    service.configure({
      timeline: async () => [
        { ...entry, tool: "browser_type", args: { selector: "#otp", text: "987654" } },
      ],
    });
    const saved = await service.createKnowledge(
      { ...knowledge, note: "password=credential otp=987654 token=foo" },
      actor,
    );
    expect(JSON.stringify(saved)).not.toMatch(/credential|987654|=foo/);
    expect(saved.steps[0].replayable).toBe(false);
    await expect(
      service.acceptKnowledge(saved.id, actor, {
        sessionId: "s1",
        expectedVersion: 1,
        accepted: true,
        idempotencyKey: "attempt",
        controlToken: "lease",
      }),
    ).rejects.toMatchObject({ code: "review_steps" });
  });
  it("enforces private ownership and operator-only sharing", async () => {
    const saved = await service.createKnowledge(knowledge, actor);
    expect(await service.listKnowledge({ ...actor, id: "bob" })).toEqual([]);
    await expect(
      service.updateKnowledge(
        saved.id,
        { ...actor, id: "bob" },
        { expectedVersion: 1, note: "changed" },
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      service.createKnowledge({ ...knowledge, visibility: "workspace" }, actor),
    ).rejects.toMatchObject({ code: "operator_required" });
  });
  it("requires acceptance, valid control and origin; idempotent acceptance starts once", async () => {
    const saved = await service.createKnowledge(knowledge, actor);
    await expect(
      service.acceptKnowledge(saved.id, actor, {
        sessionId: "s1",
        expectedVersion: 1,
        accepted: false,
        idempotencyKey: "attempt",
      }),
    ).rejects.toMatchObject({ code: "acceptance_required" });
    const input = {
      sessionId: "s1",
      expectedVersion: 1,
      accepted: true,
      idempotencyKey: "attempt",
      controlToken: "lease",
    };
    const first = await service.acceptKnowledge(saved.id, actor, input);
    const repeat = await service.acceptKnowledge(saved.id, actor, input);
    expect(first).toEqual(repeat);
    expect(adapters.applyRecovery).toHaveBeenCalledTimes(1);
    expect(adapters.authorize).toHaveBeenCalledWith("s1", actor, "lease", true);
  });
  it("rejects invalid recovery commands before reserving an acceptance", async () => {
    const saved = await service.createKnowledge(knowledge, actor);
    const invalid = await service.updateKnowledge(saved.id, actor, {
      expectedVersion: 1,
      steps: [{ seq: 1, tool: "browser_click", args: {}, replayable: true }],
    });
    const input = {
      expectedVersion: invalid.version,
      sessionId: "s1",
      accepted: true,
      idempotencyKey: "invalid-command",
    };
    await expect(service.acceptKnowledge(saved.id, actor, input)).rejects.toMatchObject({
      code: "invalid_recovery_step",
    });
    await expect(service.acceptKnowledge(saved.id, actor, input)).rejects.toMatchObject({
      code: "invalid_recovery_step",
    });
    expect(adapters.applyRecovery).not.toHaveBeenCalled();
  });
  it("does not replay an ambiguous failed application after a restart", async () => {
    const saved = await service.createKnowledge(knowledge, actor);
    service.configure({
      applyRecovery: async () => {
        throw new Error("connection lost after submission");
      },
    });
    const input = {
      sessionId: "s1",
      expectedVersion: 1,
      accepted: true,
      idempotencyKey: "attempt",
      controlToken: "lease",
    };
    await expect(service.acceptKnowledge(saved.id, actor, input)).rejects.toThrow(
      "connection lost",
    );
    const restarted = new WorkbenchService(
      store,
      adapters,
      () => {},
      () => now,
    );
    await expect(restarted.acceptKnowledge(saved.id, actor, input)).rejects.toMatchObject({
      code: "acceptance_uncertain",
    });
    expect(adapters.applyRecovery).not.toHaveBeenCalled();
  });
  it("omits expired advice from suggestions and rejects applying it", async () => {
    const saved = await service.createKnowledge({ ...knowledge, expiresInDays: 1 }, actor);
    const later = new WorkbenchService(
      store,
      adapters,
      () => {},
      () => now + 2 * 86400000,
    );
    expect(
      await later.listKnowledge(actor, { origin: "https://example.com", suggestions: true }),
    ).toEqual([]);
    await expect(
      later.acceptKnowledge(saved.id, actor, {
        sessionId: "s1",
        expectedVersion: 1,
        accepted: true,
        idempotencyKey: "attempt",
      }),
    ).rejects.toMatchObject({ code: "stale_knowledge" });
  });
});

describe("state explanation", () => {
  it("prioritizes a review while retaining handoff/control/run reasons", () => {
    const result = explainState(
      {
        session: { id: "s1", status: "live" },
        reviews: [{ ...rows[0], kind: "review", status: "pending" }],
        handoff: { ...handoff, status: "waiting" },
        ownership: { ownerId: "alice", mode: "human", expiresAt: "2026-11-10T12:10:00Z" },
        runs: [rows[0]],
        lastAction: entry,
        unavailable: ["queue", "queue"],
      },
      now,
    );
    expect(result.primary.code).toBe("review");
    expect(result.reasons.map((r) => r.code)).toEqual([
      "review",
      "handoff",
      "human_control",
      "run_failed",
    ]);
    expect(result.lastAction?.tool).toBe("browser_click");
    expect(result.unavailable).toEqual(["queue"]);
  });
  it("ignores expired leases/handoffs and explains resumed work", () => {
    const result = explainState(
      {
        session: { id: "s1", status: "live" },
        handoff: { ...handoff, status: "waiting", expiresAt: "2026-11-10T11:00:00Z" },
        ownership: { ownerId: "alice", mode: "human", expiresAt: "2026-11-10T11:00:00Z" },
        runs: [{ ...rows[0], status: "running" }],
        unavailable: [],
      },
      now,
    );
    expect(result.primary.code).toBe("running");
    expect(result.reasons).toHaveLength(1);
  });
  it("represents missing telemetry and does not invent task progress", () => {
    const result = explainState(
      {
        session: { id: "s1", status: "parked", parkReason: "idle_timeout" },
        unavailable: ["durable_runs"],
      },
      now,
    );
    expect(result.primary.code).toBe("parked");
    expect(result.lastAction).toBeNull();
    expect(result.unavailable).toContain("durable_runs");
    expect(redactNote("https://user:pass@example.com?token=value")).not.toContain("pass");
  });
});
