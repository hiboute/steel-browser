import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PlatformStore } from "../platform/store.js";
import { PlatformEvents } from "../platform/events.js";
import { WorkflowService } from "./workflows.service.js";
import { canonical, digest, nextScheduledAt, substitute } from "./workflows.utils.js";
import type {
  StepContext,
  WorkflowActor,
  WorkflowRun,
  WorkflowRuntime,
  WorkflowStep,
} from "./workflows.types.js";

const alice: WorkflowActor = { id: "alice", role: "agent", authenticated: true };
const bob: WorkflowActor = { id: "bob", role: "agent", authenticated: true };
const operator: WorkflowActor = { id: "operator", role: "operator", authenticated: true };
class Runtime implements WorkflowRuntime {
  records = new Map<string, WorkflowRun>();
  kinds = new Map<string, Parameters<WorkflowRuntime["registerKind"]>[1]>();
  hooks: Array<(ctx: StepContext) => Promise<void>> = [];
  calls: Array<{ input: Parameters<WorkflowRuntime["create"]>[0]; actor: WorkflowActor }> = [];
  registerKind(kind: string, handler: Parameters<WorkflowRuntime["registerKind"]>[1]) {
    this.kinds.set(kind, handler);
  }
  beforeStep(hook: (ctx: StepContext) => Promise<void>) {
    this.hooks.push(hook);
  }
  pauseError(reason: string) {
    return new Error(reason);
  }
  async create(input: Parameters<WorkflowRuntime["create"]>[0], actor: WorkflowActor) {
    const existing = this.calls.find(
      (c) => c.actor.id === actor.id && c.input.idempotencyKey === input.idempotencyKey,
    );
    if (existing)
      return [...this.records.values()].find((r) => r.metadata?.key === input.idempotencyKey)!;
    this.calls.push({ input, actor });
    const now = new Date().toISOString();
    const run: WorkflowRun = {
      id: randomUUID(),
      sessionId: input.sessionId ?? randomUUID(),
      ownerId: actor.id,
      status: "queued",
      revision: 1,
      cursor: 0,
      steps: input.steps,
      results: input.steps.map((s) => ({ stepId: s.id, status: "pending" })),
      metadata: { ...input.metadata, key: input.idempotencyKey },
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(run.id, run);
    return run;
  }
  get(id: string, actor: WorkflowActor) {
    const run = this.records.get(id);
    if (!run) throw new Error("notfound");
    if (run.ownerId !== actor.id && actor.role !== "operator") throw new Error("denied");
    return run;
  }
  list(actor: WorkflowActor) {
    return [...this.records.values()].filter(
      (r) => r.ownerId === actor.id || actor.role === "operator",
    );
  }
  async resume(id: string, actor: WorkflowActor) {
    const run = this.get(id, actor);
    run.status = "queued";
    return run;
  }
  async cancel(id: string, actor: WorkflowActor) {
    const run = this.get(id, actor);
    run.status = "cancelled";
    return run;
  }
  context(
    run: WorkflowRun,
    step: WorkflowStep,
    response: any = {
      status: 200,
      body: {
        page: { url: "https://fixture.test/receipt" },
        results: [{ ok: true, value: "Done", snapshot: '- textbox "Name" [ref=e1] value="Ada"' }],
      },
    },
  ): StepContext {
    return {
      run,
      step,
      session: {},
      actor: alice,
      signal: new AbortController().signal,
      execute: vi.fn(async () => response),
    };
  }
}

let root: string;
let store: PlatformStore;
let runtime: Runtime;
let events: PlatformEvents;
let service: WorkflowService;
let now: Date;
let reviewHold: (sessionId: string) => () => void, reviewRelease: () => void;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "steel-workflows-"));
  store = new PlatformStore(root, "test-key");
  runtime = new Runtime();
  events = new PlatformEvents();
  now = new Date("2026-11-10T12:00:00Z");
  reviewRelease = vi.fn();
  reviewHold = vi.fn(() => reviewRelease);
  service = new WorkflowService({
    store,
    runtime,
    events,
    now: () => now,
    replayOrigins: ["https://fixture.test"],
    releaseReplaySession: async () => {},
    evidenceAllowed: () => true,
    authorizeWatcher: () => {},
    holdReviewSession: reviewHold,
  });
  await service.initialize(false);
});
afterEach(async () => {
  await service.close();
  await rm(root, { recursive: true, force: true });
});
const procedure = () => ({
  name: "Submit fixture",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { name: { type: "string" } },
    required: ["name"],
  },
  steps: [
    {
      id: "fill",
      kind: "commands",
      input: { commands: [{ command: "fill", target: "#name", value: { $input: "name" } }] },
    },
    {
      id: "submit",
      kind: "commands",
      input: { commands: [{ command: "click", target: "#submit" }] },
      review: {
        summary: "Submit fixture",
        destination: "https://fixture.test/submit",
        fields: { name: { $input: "name" } },
        attachments: [],
      },
    },
    {
      id: "verify",
      kind: "assert",
      assertion: {
        id: "confirmation",
        label: "Confirmation visible",
        command: { command: "get", what: "text", target: "#receipt" },
        operator: "equals",
        expected: "Done",
      },
    },
  ],
});

describe("immutable procedures and safe compilation", () => {
  it("pins versions, substitutes typed inputs, compiles review-before-command and passes only ephemeral lease", async () => {
    const saved = await service.saveProcedure(procedure(), alice);
    await service.saveProcedure(
      { ...procedure(), id: saved.id, expectedVersion: 1, name: "Updated" },
      alice,
    );
    const run = await service.startProcedure(
      saved.id,
      { version: 1, inputs: { name: "Ada" }, sessionId: "session", idempotencyKey: "one" },
      alice,
      { controlToken: "transient" },
    );
    expect(run.metadata?.productProcedureVersion).toBe(1);
    expect(run.steps.map((s) => s.kind)).toEqual([
      "commands",
      "product.review",
      "commands",
      "product.assert",
    ]);
    expect((run.steps[0].input as any).commands[0].value).toBe("Ada");
    expect((run.steps[1].input as any).proposal.fields).toEqual({ name: "Ada" });
    expect(runtime.calls[0].input.controlToken).toBe("transient");
    expect(canonical(await store.read("workflows/manifest.json"))).not.toContain("transient");
    await expect(
      service.saveProcedure({ ...procedure(), id: saved.id, expectedVersion: 1 }, alice),
    ).rejects.toMatchObject({ code: "procedure_version_conflict" });
    expect(service.getProcedure(saved.id, 1, alice).name).toBe("Submit fixture");
  });
  it("rejects invalid inputs, credentials, cross-owner access and unsafe references", async () => {
    const saved = await service.saveProcedure(procedure(), alice);
    await expect(
      service.startProcedure(saved.id, { inputs: { name: 4 }, idempotencyKey: "one" }, alice),
    ).rejects.toMatchObject({ code: "invalid_procedure_inputs" });
    expect(() => service.getProcedure(saved.id, 1, bob)).toThrow("another principal");
    await expect(
      service.saveProcedure({ ...procedure(), inputSchema: { password: "plaintext" } }, alice),
    ).rejects.toMatchObject({ code: "secret_value_forbidden" });
    expect(() => substitute({ $input: "constructor.name" }, { name: "Ada" })).toThrow(
      "Missing procedure input",
    );
    await expect(
      service.saveProcedure(procedure(), { ...alice, authenticated: false }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });
  it("does not turn arbitrary timeline text into executable actions", async () => {
    await expect(
      service.createFromActions(
        { name: "Bad", actions: [{ id: "one", input: { tool: "shell", args: "do something" } }] },
        alice,
      ),
    ).rejects.toThrow();
    const saved = await service.createFromActions(
      {
        name: "Read",
        actions: [{ id: "one", input: { commands: [{ command: "get", what: "title" }] } }],
      },
      alice,
    );
    expect(saved.steps).toHaveLength(1);
    const portable = await service.createFromActions(
      {
        name: "Portable",
        actions: [
          {
            id: "read",
            input: {
              after: "old-session-token",
              commands: [{ command: "get", what: "title" }],
              observe: { mode: "diff", base: "old-snapshot" },
            },
          },
        ],
      },
      alice,
    );
    expect((portable.steps[0] as any).input.after).toBeUndefined();
    expect((portable.steps[0] as any).input.observe.mode).toBe("snapshot");
    await expect(
      service.createFromActions(
        {
          name: "Stale",
          actions: [{ id: "click", input: { commands: [{ command: "click", target: "@e1" }] } }],
        },
        alice,
      ),
    ).rejects.toMatchObject({ code: "ephemeral_procedure_ref" });
  });
});

describe("exact-content reviews", () => {
  async function pending() {
    const p = await service.saveProcedure(procedure(), alice);
    const run = await service.startProcedure(
      p.id,
      { inputs: { name: "Ada" }, idempotencyKey: "review" },
      alice,
    );
    const step = run.steps[1];
    const result = await runtime.kinds.get("product.review")!.execute(runtime.context(run, step));
    run.status = "paused";
    run.cursor = 1;
    return { run, step, result, review: (await service.listReviews(alice))[0] };
  }
  it("pauses, rejects stale content and agent approvals, resumes only after an operator decision", async () => {
    const { run, review, result } = await pending();
    expect(result.status).toBe("paused");
    await expect(
      service.decideReview(
        review.id,
        { decision: "approve", contentHash: review.contentHash },
        alice,
      ),
    ).rejects.toMatchObject({ code: "operator_required" });
    await expect(
      service.decideReview(
        review.id,
        { decision: "approve", contentHash: "0".repeat(64) },
        operator,
      ),
    ).rejects.toMatchObject({ code: "review_content_changed" });
    await expect(runtime.hooks[0](runtime.context(run, run.steps[2]))).rejects.toThrow(
      "review_required",
    );
    await service.decideReview(
      review.id,
      { decision: "approve", contentHash: review.contentHash },
      operator,
    );
    expect(run.status).toBe("queued");
    await expect(runtime.hooks[0](runtime.context(run, run.steps[2]))).resolves.toBeUndefined();
    const edited = runtime.context(run, run.steps[2], {
      status: 200,
      body: {
        page: { url: "https://fixture.test/receipt" },
        results: [{ ok: true, snapshot: '- textbox "Name" [ref=e1] value="Changed"' }],
      },
    });
    await expect(runtime.hooks[0](edited)).rejects.toThrow("review_state_changed");
    (run.steps[2].input as any).commands[0].target = "#different";
    await expect(runtime.hooks[0](runtime.context(run, run.steps[2]))).rejects.toThrow(
      "review_required",
    );
  });
  it("serializes racing decisions and preserves a decision over restart", async () => {
    const { review } = await pending();
    const outcomes = await Promise.allSettled([
      service.decideReview(
        review.id,
        { decision: "approve", contentHash: review.contentHash },
        operator,
      ),
      service.decideReview(
        review.id,
        { decision: "reject", contentHash: review.contentHash },
        operator,
      ),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    await service.close();
    runtime.kinds.clear();
    runtime.hooks = [];
    service = new WorkflowService({ store, runtime, events });
    await service.initialize(false);
    expect((await service.getReview(review.id, alice)).status).toBe("approved");
    await expect(service.getReview(review.id, bob)).rejects.toMatchObject({ statusCode: 403 });
  });
  it("rejecting cancels the prepared run without executing its action", async () => {
    const { run, review } = await pending();
    await service.decideReview(
      review.id,
      { decision: "reject", contentHash: review.contentHash },
      operator,
    );
    expect(run.status).toBe("cancelled");
  });
  it("holds idle expiry only through the bounded review window and refuses late approval", async () => {
    const { run, review } = await pending();
    expect(reviewHold).toHaveBeenCalledWith(run.sessionId);
    expect(Date.parse(review.expiresAt) - Date.parse(review.createdAt)).toBe(900000);
    now = new Date(now.getTime() + 899999);
    await service.tick();
    expect(reviewRelease).not.toHaveBeenCalled();
    expect((await service.getReview(review.id, alice)).status).toBe("pending");
    now = new Date(now.getTime() + 2);
    await service.tick();
    expect(reviewRelease).toHaveBeenCalledOnce();
    expect((await service.getReview(review.id, alice)).status).toBe("expired");
    expect(run.status).toBe("cancelled");
    await expect(
      service.decideReview(
        review.id,
        { decision: "approve", contentHash: review.contentHash },
        operator,
      ),
    ).rejects.toMatchObject({ code: "review_expired" });
  });
  it("releases a pending review hold on cancellation and rejects stale decisions", async () => {
    const { run, review } = await pending();
    run.status = "cancelled";
    events.publish("run.updated", { run });
    expect(reviewRelease).toHaveBeenCalledOnce();
    await expect(
      service.decideReview(
        review.id,
        { decision: "approve", contentHash: review.contentHash },
        operator,
      ),
    ).rejects.toMatchObject({ code: "review_not_waiting" });
    expect((await service.getReview(review.id, alice)).status).toBe("pending");
  });
});

describe("grounded completion receipts", () => {
  it("only verifies completed runs with successful observed assertions", async () => {
    const p = await service.saveProcedure(procedure(), alice);
    const run = await service.startProcedure(
      p.id,
      { inputs: { name: "Ada" }, idempotencyKey: "receipt" },
      alice,
    );
    const step = run.steps.at(-1)!;
    const outcome = await runtime.kinds.get("product.assert")!.execute(runtime.context(run, step));
    run.results[3] = { stepId: step.id, status: "succeeded", output: outcome.output };
    expect((await service.getReceipt(run.id, alice)).status).toBe("waiting");
    run.status = "completed";
    run.revision++;
    expect((await service.getReceipt(run.id, alice)).status).toBe("verified");
    expect((await service.getReceipt(run.id, alice)).assertions[0]).toMatchObject({
      actual: "Done",
      source: "browser-command",
      url: "https://fixture.test/receipt",
    });
    run.status = "uncertain";
    run.revision++;
    expect((await service.getReceipt(run.id, alice)).status).toBe("uncertain");
  });
  it("records a mismatched assertion, masks unavailable observations and denies mutating assertions", async () => {
    const p = await service.saveProcedure(procedure(), alice);
    const run = await service.startProcedure(
      p.id,
      { inputs: { name: "Ada" }, idempotencyKey: "failed" },
      alice,
    );
    const step = run.steps.at(-1)!;
    const failed = await runtime.kinds.get("product.assert")!.execute(
      runtime.context(run, step, {
        status: 200,
        body: { results: [{ ok: true, value: "Not yet" }] },
      }),
    );
    expect((failed.output as any).assertion.status).toBe("failed");
    const masked = await runtime.kinds.get("product.assert")!.execute(
      runtime.context(run, step, {
        status: 200,
        body: { results: [{ ok: true, masked: true, value: "secret" }] },
      }),
    );
    expect((masked.output as any).assertion).toMatchObject({
      status: "unavailable",
      actual: undefined,
    });
    expect(() =>
      runtime.kinds.get("product.assert")!.validate({
        id: "bad",
        label: "Bad",
        command: { command: "eval", script: "fetch('/send')" },
        operator: "exists",
      }),
    ).toThrow("read-only");
    run.status = "completed";
    expect((await service.getReceipt(run.id, alice)).status).toBe("uncertain");
  });
  it("stores optional screenshot evidence encrypted with a different command idempotency key", async () => {
    const p = await service.saveProcedure(procedure(), alice);
    const run = await service.startProcedure(
      p.id,
      { inputs: { name: "Ada" }, idempotencyKey: "evidence" },
      alice,
    );
    const step = structuredClone(run.steps.at(-1)!);
    (step.input as any).evidence = "screenshot";
    const ctx = runtime.context(run, step);
    ctx.execute = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, body: { results: [{ ok: true, value: "Done" }] } })
      .mockResolvedValueOnce({
        status: 200,
        body: { results: [{ ok: true, data: Buffer.from("png").toString("base64") }] },
      });
    const outcome = await runtime.kinds.get("product.assert")!.execute(ctx);
    const evidence = (outcome.output as any).assertion.evidence;
    expect(evidence.sha256).toHaveLength(64);
    expect((await service.getEvidence(evidence.artifactId, alice)).data.toString()).toBe("png");
    await expect(service.getEvidence(evidence.artifactId, bob)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect((ctx.execute as any).mock.calls[0][1]).not.toBe((ctx.execute as any).mock.calls[1][1]);
  });
});

describe("durable schedules and triggers", () => {
  async function saved() {
    return service.saveProcedure(
      {
        name: "Read",
        steps: [
          {
            id: "read",
            kind: "commands",
            input: { commands: [{ command: "get", what: "title" }] },
          },
        ],
      },
      alice,
    );
  }
  it("authenticates and deduplicates webhooks; concurrency and deadlines are enforced", async () => {
    const p = await saved();
    const schedule = await service.putSchedule(
      {
        name: "Webhook",
        procedureId: p.id,
        version: 1,
        trigger: { kind: "webhook" },
        deadlineSeconds: 60,
      },
      alice,
    );
    await expect(service.webhook(schedule.id, "wrong", "one")).rejects.toMatchObject({
      statusCode: 401,
    });
    const first = await service.webhook(schedule.id, schedule.webhookToken!, "one");
    const duplicate = await service.webhook(schedule.id, schedule.webhookToken!, "one");
    expect(duplicate.runId).toBe(first.runId);
    expect(runtime.calls).toHaveLength(1);
    expect((await service.webhook(schedule.id, schedule.webhookToken!, "two")).reason).toBe(
      "concurrency_limit",
    );
    expect(JSON.stringify(service.listSchedules(alice))).not.toContain(schedule.webhookToken!);
    now = new Date(now.getTime() + 61000);
    await service.tick();
    expect(runtime.records.get(first.runId!)?.status).toBe("cancelled");
  });
  it("records skipped missed deadlines and runs exactly once after an eligible interval", async () => {
    const p = await saved();
    const s = await service.putSchedule(
      {
        name: "Clock",
        procedureId: p.id,
        version: 1,
        trigger: { kind: "interval", everySeconds: 60 },
        maxLatenessSeconds: 60,
        missedRun: "skip",
      },
      alice,
    );
    now = new Date(now.getTime() + 180000);
    await service.tick();
    expect(runtime.calls).toHaveLength(0);
    expect((await service.scheduleHistory(s.id, alice))[0].reason).toBe("missed_deadline");
    now = new Date(now.getTime() + 60000);
    await Promise.all([service.tick(), service.tick()]);
    expect(runtime.calls).toHaveLength(1);
    await expect(service.removeProcedure(p.id, alice)).rejects.toMatchObject({
      code: "procedure_in_use",
    });
  });
  it("recovers a delivery created before a crash without treating its own run as competing work", async () => {
    const p = await saved();
    const schedule = await service.putSchedule(
      { name: "Recover", procedureId: p.id, version: 1, trigger: { kind: "webhook" } },
      alice,
    );
    const first = await service.webhook(schedule.id, schedule.webhookToken!, "crash");
    const file = `workflows/deliveries/${first.id}.json`;
    const interrupted = { ...first, state: "pending", runId: undefined };
    await store.write(file, interrupted);
    await service.tick();
    const recovered = await store.read<any>(file);
    expect(recovered.state).toBe("started");
    expect(recovered.runId).toBe(first.runId);
    expect(runtime.calls).toHaveLength(1);
  });
  it("pins pending delivery inputs over schedule edits and refuses expired work before admission", async () => {
    const p = await service.saveProcedure(
      {
        name: "Parameterized",
        inputSchema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
        },
        steps: [
          {
            id: "read",
            kind: "assert",
            assertion: {
              id: "title",
              label: "Title",
              command: { command: "get", what: "title" },
              operator: "equals",
              expected: { $input: "title" },
            },
          },
        ],
      },
      alice,
    );
    const schedule = await service.putSchedule(
      {
        name: "Pending",
        procedureId: p.id,
        version: 1,
        inputs: { title: "Original" },
        trigger: { kind: "webhook" },
      },
      alice,
    );
    const key = "webhook:pending",
      id = digest({ scheduleId: schedule.id, key });
    await store.write(`workflows/deliveries/${id}.json`, {
      id,
      scheduleId: schedule.id,
      ownerId: alice.id,
      key,
      state: "pending",
      at: now.toISOString(),
      deadlineAt: new Date(now.getTime() + 60000).toISOString(),
      definition: { procedureId: p.id, version: 1, inputs: { title: "Original" } },
    });
    await service.putSchedule(
      {
        id: schedule.id,
        name: "Edited",
        procedureId: p.id,
        version: 1,
        inputs: { title: "Edited" },
        trigger: { kind: "webhook" },
      },
      alice,
    );
    await service.tick();
    expect((runtime.calls[0].input.steps[0].input as any).expected).toBe("Original");
    const expiredKey = "webhook:expired",
      expiredId = digest({ scheduleId: schedule.id, key: expiredKey });
    await store.write(`workflows/deliveries/${expiredId}.json`, {
      id: expiredId,
      scheduleId: schedule.id,
      ownerId: alice.id,
      key: expiredKey,
      state: "pending",
      at: now.toISOString(),
      deadlineAt: new Date(now.getTime() - 1).toISOString(),
      definition: { procedureId: p.id, version: 1, inputs: { title: "Never execute" } },
    });
    await service.tick();
    expect(runtime.calls).toHaveLength(1);
    expect((await store.read<any>(`workflows/deliveries/${expiredId}.json`)).reason).toBe(
      "delivery_deadline_expired",
    );
  });
  it("daily DST gaps skip absent wall times and repeated hours only run once per date", () => {
    expect(
      nextScheduledAt(
        { trigger: { kind: "daily", at: "02:30", timezone: "America/New_York" } },
        new Date("2026-03-08T06:59:00Z"),
      ),
    ).toBe("2026-03-09T06:30:00.000Z");
    expect(
      nextScheduledAt(
        {
          trigger: { kind: "daily", at: "01:30", timezone: "America/New_York" },
          lastLocalDate: "2026-11-01",
        },
        new Date("2026-11-01T05:31:00Z"),
      ),
    ).toBe("2026-11-02T06:30:00.000Z");
  });
  it("watcher match events launch their pinned procedure", async () => {
    const p = await saved();
    await service.putSchedule(
      {
        name: "Watch",
        procedureId: p.id,
        version: 1,
        trigger: { kind: "watcher", watcherId: "watch1" },
      },
      alice,
    );
    events.publish("watcher.run", { watcherId: "watch1", matched: false });
    await new Promise((r) => setTimeout(r, 10));
    expect(runtime.calls).toHaveLength(0);
    events.publish("watcher.run", { watcherId: "watch1", matched: true });
    await vi.waitFor(() => expect(runtime.calls).toHaveLength(1));
  });
});

describe("regression replay and recovery export", () => {
  it("requires a verified pinned baseline, identical inputs and configured owned origins", async () => {
    const p = await service.saveProcedure(
      {
        name: "Read",
        steps: [
          {
            id: "read",
            kind: "commands",
            input: { commands: [{ command: "navigate", url: "https://fixture.test/" }] },
          },
          {
            id: "assert",
            kind: "assert",
            assertion: {
              id: "title",
              label: "Title",
              command: { command: "get", what: "title" },
              operator: "equals",
              expected: "Done",
            },
          },
        ],
      },
      alice,
    );
    const run = await service.startProcedure(p.id, { idempotencyKey: "baseline" }, alice);
    const request = {
      baselineRunId: run.id,
      candidate: { label: "candidate" },
      allowedOrigins: ["https://fixture.test"],
      idempotencyKey: "candidate",
    };
    await expect(service.startReplay(request, alice)).rejects.toMatchObject({
      code: "invalid_baseline",
    });
    run.status = "completed";
    run.revision++;
    run.results[1] = {
      stepId: "assert",
      status: "succeeded",
      output: {
        assertion: {
          id: "title",
          label: "Title",
          status: "passed",
          actual: "Done",
          operator: "equals",
          observedAt: now.toISOString(),
          source: "browser-command",
        },
      },
    };
    await expect(
      service.startReplay({ ...request, allowedOrigins: ["https://production.test"] }, alice),
    ).rejects.toMatchObject({ code: "fixture_not_configured" });
    await expect(
      service.startReplay({ ...request, inputs: { other: 1 } }, alice),
    ).rejects.toMatchObject({ code: "replay_input_mismatch" });
    const replay = await service.startReplay(request, alice);
    const candidate = runtime.records.get(replay.candidateRunId)!;
    expect(runtime.calls.at(-1)?.input.sessionId).toBeUndefined();
    expect(candidate.metadata?.productReplay).toBe(true);
    candidate.status = "completed";
    candidate.results[1] = { ...run.results[1] };
    candidate.revision++;
    expect((await service.getReplay(replay.id, alice)).status).toBe("passed");
    candidate.results[1] = structuredClone(run.results[1]);
    (candidate.results[1].output as any).assertion.actual = "Different";
    candidate.revision++;
    expect((await service.getReplay(replay.id, alice)).status).toBe("regressed");
  });
  it("exports all immutable versions and atomically restores schedules disabled without webhook secrets", async () => {
    const p = await service.saveProcedure(procedure(), alice);
    await service.saveProcedure(
      { ...procedure(), id: p.id, expectedVersion: 1, name: "v2" },
      alice,
    );
    const schedule = await service.putSchedule(
      {
        name: "Webhook",
        procedureId: p.id,
        version: 1,
        inputs: { name: "Ada" },
        trigger: { kind: "webhook" },
      },
      alice,
    );
    const backup = service.exportResources(alice);
    expect(backup.procedures).toHaveLength(2);
    expect(backup.schedules[0].enabled).toBe(false);
    expect(JSON.stringify(backup)).not.toContain(schedule.webhookToken!);
    await service.removeSchedule(schedule.id, alice);
    await service.removeProcedure(p.id, alice);
    expect((await service.importResources(backup, alice)).importedProcedures).toBe(1);
    expect(service.procedureVersions(p.id, alice)).toHaveLength(2);
    const tampered = structuredClone(backup);
    tampered.procedures[0].name = "tampered";
    await expect(service.validateResources(tampered, alice)).rejects.toMatchObject({
      code: "restore_digest_mismatch",
    });
    await expect(service.importResources(backup, alice)).rejects.toMatchObject({
      code: "restore_conflict",
    });
    expect(service.listSchedules(alice)).toHaveLength(1);
  });
});
