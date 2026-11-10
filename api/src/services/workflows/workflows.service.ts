import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { requestSchema } from "../commands/commands.js";
import { parseRef } from "../commands/refs.js";
import { validateExtractedData } from "../extract-validation.js";
import type { PlatformStore } from "../platform/store.js";
import type { PlatformEvents } from "../platform/events.js";
import type { Session } from "../session.service.js";
import { withNavigationPolicy } from "../navigation-policy.js";
import { redactArguments } from "../handoff/agent-feature-utils.js";
import {
  AssertionSchema,
  ProcedureInputSchema,
  ProcedureStartSchema,
  ProposalSchema,
  ScheduleInputSchema,
  ProductId,
  WorkflowError,
  type Assertion,
  type AssertionResult,
  type CompletionReceipt,
  type ProcedureInput,
  type ProcedureVersion,
  type ProcedureStart,
  type ReviewRecord,
  type ScheduleInput,
  type ScheduleRecord,
  type StepContext,
  ReplayInputSchema,
  type ReplayRecord,
  type TriggerRecord,
  type WorkflowActor,
  type WorkflowRun,
  type WorkflowRuntime,
  type WorkflowStep,
} from "./workflows.types.js";
import {
  atPath,
  canonical,
  digest,
  equalDigest,
  localParts,
  nextScheduledAt,
  substitute,
  validateSafePayload,
  validateInputSchema,
} from "./workflows.utils.js";

interface Manifest {
  schemaVersion: 1;
  procedures: Record<string, ProcedureVersion[]>;
  schedules: Record<string, ScheduleRecord>;
}
interface Dependencies {
  store: PlatformStore;
  runtime: WorkflowRuntime;
  events: Pick<PlatformEvents, "publish" | "subscribe">;
  now?: () => Date;
  onError?: (error: unknown) => void;
  replayOrigins?: string[];
  replayAllowPrivateNetworks?: boolean;
  releaseReplaySession?: (sessionId: string) => Promise<void>;
  holdReviewSession?: (sessionId: string) => () => void;
  evidenceAllowed?: (sessionId: string) => boolean;
  isSensitiveSession?: (sessionId: string) => boolean;
  vaultFill?: (
    ctx: StepContext,
    input: { reference: string; selector: string; frameUrl?: string },
  ) => Promise<unknown>;
  verifyAttachment?: (
    ctx: StepContext,
    attachment: ReviewRecord["proposal"]["attachments"][number],
  ) => Promise<void>;
  authorizeWatcher?: (watcherId: string, actor: WorkflowActor) => Promise<void> | void;
}
const terminal = new Set(["completed", "failed", "cancelled"]);
const ReviewInput = z
  .object({
    proposal: ProposalSchema,
    command: z.record(z.string(), z.unknown()),
    actionStepId: ProductId,
    timeoutMs: z.number().int().min(1000).max(3600000).default(900000),
  })
  .strict();
const readOnly = new Set(["get", "is", "snapshot", "find", "screenshot"]);
const VaultInput = z
  .object({
    reference: ProductId,
    selector: z.string().min(1).max(2000),
    frameUrl: z.string().url().optional(),
  })
  .strict();

export class WorkflowService {
  private manifest: Manifest = { schemaVersion: 1, procedures: {}, schedules: {} };
  private pending = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  private tickTask?: Promise<void>;
  private closed = false;
  private readonly replayGuards = new Map<
    string,
    {
      sessionId: string;
      release: () => void;
      task: Promise<void>;
      check: () => void;
      closing?: Promise<void>;
      closed?: boolean;
    }
  >();
  private readonly now: () => Date;
  private readonly reviewHolds = new Map<
    string,
    { runId: string; sessionId: string; release: () => void; timer: NodeJS.Timeout }
  >();
  constructor(private readonly deps: Dependencies) {
    this.now = deps.now ?? (() => new Date());
    this.deps.runtime.registerKind("product.review", {
      validate: (input) => ReviewInput.parse(input),
      replay: "safe",
      execute: (ctx) => this.executeReview(ctx),
    });
    this.deps.runtime.registerKind("product.assert", {
      validate: (input) => this.validateAssertion(input),
      replay: "safe",
      execute: (ctx) => this.executeAssertion(ctx),
    });
    this.deps.runtime.registerKind("product.vault_fill", {
      validate: (input) => {
        if (!this.deps.vaultFill)
          throw new WorkflowError(
            "vault_unavailable",
            "Vault-assisted workflow fills are not configured",
            503,
          );
        return VaultInput.parse(input);
      },
      replay: "ambiguous",
      execute: async (ctx) => {
        await this.deps.vaultFill!(ctx, VaultInput.parse(ctx.step.input));
        return {
          status: "succeeded",
          output: { filled: true, reference: VaultInput.parse(ctx.step.input).reference },
        };
      },
    });
    this.deps.runtime.beforeStep((ctx) => this.enforceReview(ctx));
    this.deps.runtime.beforeStep((ctx) => this.guardReplay(ctx));
  }

  async initialize(startTimer = true) {
    const saved = await this.deps.store.read<Manifest>("workflows/manifest.json");
    if (saved) {
      if (saved.schemaVersion !== 1) throw new Error("Unsupported workflow manifest version");
      this.manifest = saved;
    }
    this.unsubscribe = this.deps.events.subscribe((event) => {
      if (event.type === "run.updated") {
        const run = (event.data as { run?: WorkflowRun })?.run;
        if (run?.metadata?.productProcedureId)
          void this.refreshReceipt(run).catch((e) => this.deps.onError?.(e));
        if (run && terminal.has(run.status))
          void this.finishReplay(run.id).catch((error) => this.deps.onError?.(error));
        if (run && terminal.has(run.status))
          for (const [id, hold] of this.reviewHolds)
            if (hold.runId === run.id) this.releaseReviewHold(id);
      }
      if (event.type === "watcher.run")
        void this.onWatcher(event.id, event.data).catch((e) => this.deps.onError?.(e));
    });
    // Reconcile receipts after a crash between durable completion and event delivery.
    for (const owner of new Set(
      Object.values(this.manifest.procedures)
        .flat()
        .map((p) => p.ownerId),
    )) {
      for (const run of await this.deps.runtime.list(this.systemActor(owner)))
        if (run.metadata?.productProcedureId) await this.refreshReceipt(run);
    }
    for (const file of await this.deps.store.list("workflows/reviews"))
      if (file.endsWith(".json")) {
        const review = await this.deps.store.read<ReviewRecord>(`workflows/reviews/${file}`);
        if (review?.status !== "pending") continue;
        if (Date.parse(review.expiresAt ?? review.createdAt) <= this.now().getTime())
          await this.expireReview(review.id);
        else {
          const run = await this.deps.runtime.get(review.runId, this.systemActor(review.ownerId));
          if (!terminal.has(run.status) && run.sessionId) this.holdReview(review, run.sessionId);
        }
      }
    if (startTimer) {
      this.timer = setInterval(() => void this.tick().catch((e) => this.deps.onError?.(e)), 15000);
      this.timer.unref();
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.unsubscribe?.();
    for (const id of this.reviewHolds.keys()) this.releaseReviewHold(id);
    const guards = [...this.replayGuards.values()];
    await Promise.allSettled([...this.replayGuards.keys()].map((id) => this.finishReplay(id)));
    await Promise.allSettled(guards.filter((g) => g.closed).map((g) => g.task));
    await this.tickTask;
    await this.pending;
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.pending.catch(() => undefined).then(fn);
    this.pending = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
  private holdReview(review: ReviewRecord, sessionId: string) {
    if (this.reviewHolds.has(review.id) || review.status !== "pending") return;
    const milliseconds = Date.parse(review.expiresAt) - this.now().getTime();
    if (milliseconds <= 0) return;
    const release = this.deps.holdReviewSession?.(sessionId) ?? (() => {});
    const timer = setTimeout(
      () => void this.expireReview(review.id).catch((error) => this.deps.onError?.(error)),
      Math.min(milliseconds, 3600000),
    );
    timer.unref();
    this.reviewHolds.set(review.id, { runId: review.runId, sessionId, release, timer });
  }
  private releaseReviewHold(id: string) {
    const hold = this.reviewHolds.get(id);
    if (!hold) return;
    clearTimeout(hold.timer);
    hold.release();
    this.reviewHolds.delete(id);
  }
  private async expireReview(id: string) {
    const expired = await this.serial(async () => {
      const current = await this.deps.store.read<ReviewRecord>(`workflows/reviews/${id}.json`);
      if (
        !current ||
        current.status !== "pending" ||
        Date.parse(current.expiresAt ?? current.createdAt) > this.now().getTime()
      )
        return undefined;
      this.releaseReviewHold(id);
      const next: ReviewRecord = {
        ...current,
        status: "expired",
        decidedAt: this.now().toISOString(),
        decisionBy: "deadline",
      };
      await this.deps.store.write(`workflows/reviews/${id}.json`, next);
      return next;
    });
    if (expired) {
      this.deps.events.publish("workflow.review.updated", {
        id,
        runId: expired.runId,
        ownerId: expired.ownerId,
        status: "expired",
      });
      const actor = this.systemActor(expired.ownerId);
      const run = await this.deps.runtime.get(expired.runId, actor);
      if (
        ["paused", "running"].includes(run.status) &&
        run.steps[run.cursor]?.id === expired.stepId
      )
        await this.deps.runtime.cancel(expired.runId, actor);
    }
  }
  private async finishReplay(id: string) {
    const guard = this.replayGuards.get(id);
    if (!guard) return;
    guard.closing ??= (async () => {
      await this.deps.releaseReplaySession!(guard.sessionId);
      guard.closed = true;
      guard.release();
      await guard.task.catch(() => {});
    })();
    return guard.closing;
  }
  private systemActor(id: string): WorkflowActor {
    return { id, role: "agent", authenticated: true };
  }
  private authorize(ownerId: string, actor: WorkflowActor) {
    if (!actor.authenticated)
      throw new WorkflowError(
        "authentication_required",
        "Authenticated caller identity is required",
        401,
      );
    if (ownerId !== actor.id && actor.role !== "operator")
      throw new WorkflowError("workflow_forbidden", "Workflow belongs to another principal", 403);
  }
  private assertActor(actor: WorkflowActor) {
    this.authorize(actor.id, actor);
  }
  private async persist(next: Manifest) {
    await this.deps.store.write("workflows/manifest.json", next);
    this.manifest = next;
  }
  listProcedures(actor: WorkflowActor) {
    this.assertActor(actor);
    return Object.values(this.manifest.procedures)
      .map((v) => v.at(-1)!)
      .filter((p) => p.ownerId === actor.id || actor.role === "operator")
      .map((p) => structuredClone(p));
  }
  getProcedure(id: string, version: number | undefined, actor: WorkflowActor): ProcedureVersion {
    ProductId.parse(id);
    const versions = this.manifest.procedures[id];
    const result = version ? versions?.find((v) => v.version === version) : versions?.at(-1);
    if (!result) throw new WorkflowError("procedure_not_found", "Procedure version not found", 404);
    this.authorize(result.ownerId, actor);
    return structuredClone(result);
  }
  procedureVersions(id: string, actor: WorkflowActor) {
    this.getProcedure(id, undefined, actor);
    return structuredClone(this.manifest.procedures[id]);
  }
  private async validateProcedure(input: unknown): Promise<ProcedureInput> {
    const parsed = ProcedureInputSchema.parse(input);
    validateSafePayload(parsed);
    const ids = parsed.steps.map((s) => s.id);
    if (new Set(ids).size !== ids.length)
      throw new WorkflowError("duplicate_step", "Procedure step IDs must be unique");
    await validateInputSchema(parsed.inputSchema);
    for (const step of parsed.steps) {
      if (step.kind === "commands") this.assertStableCommands(step.input);
      if (step.kind === "assert") {
        this.assertStableCommands({ commands: [step.assertion.command] });
        AssertionSchema.parse(step.assertion);
        if (!readOnly.has(String(step.assertion.command.command)))
          throw new WorkflowError(
            "mutating_assertion",
            "Assertion commands must be declared read-only",
          );
      }
    }
    return parsed;
  }
  private assertStableCommands(input: Record<string, unknown>) {
    if (
      input.after !== undefined ||
      (input.observe as { base?: unknown } | undefined)?.base !== undefined
    )
      throw new WorkflowError(
        "ephemeral_procedure_state",
        "Procedure versions cannot retain live command continuity or snapshot tokens",
      );
    const checkTarget = (target: unknown) => {
      if (Array.isArray(target)) target.forEach(checkTarget);
      else if (typeof target === "string" && parseRef(target))
        throw new WorkflowError(
          "ephemeral_procedure_ref",
          "Replace snapshot references with stable locators before saving a procedure",
        );
    };
    const commands = Array.isArray(input.commands) ? input.commands : [input.commands];
    for (const command of commands)
      if (command && typeof command === "object")
        for (const key of ["target", "source", "frame"])
          checkTarget((command as Record<string, unknown>)[key]);
  }
  async saveProcedure(input: unknown, actor: WorkflowActor): Promise<ProcedureVersion> {
    this.assertActor(actor);
    const parsed = await this.validateProcedure(input);
    return this.serial(async () => {
      const id = parsed.id ?? randomUUID();
      const previous = this.manifest.procedures[id]?.at(-1);
      if (previous) this.authorize(previous.ownerId, actor);
      if (previous && parsed.expectedVersion !== previous.version)
        throw new WorkflowError(
          "procedure_version_conflict",
          "Supply the current expectedVersion when editing a procedure",
          409,
        );
      if (!previous && parsed.expectedVersion !== undefined)
        throw new WorkflowError(
          "procedure_version_conflict",
          "Procedure has no existing version",
          409,
        );
      const { expectedVersion: _, ...definition } = parsed;
      const record: ProcedureVersion = {
        ...definition,
        id,
        version: (previous?.version ?? 0) + 1,
        ownerId: previous?.ownerId ?? actor.id,
        createdAt: this.now().toISOString(),
        digest: digest({ ...definition, id }),
      };
      const next = structuredClone(this.manifest);
      next.procedures[id] = [...(next.procedures[id] ?? []), record];
      await this.persist(next);
      this.deps.events.publish("workflow.procedure.updated", {
        id,
        ownerId: record.ownerId,
        name: record.name,
        version: record.version,
        updatedAt: record.createdAt,
      });
      return structuredClone(record);
    });
  }
  async removeProcedure(id: string, actor: WorkflowActor) {
    return this.serial(async () => {
      this.getProcedure(id, undefined, actor);
      if (Object.values(this.manifest.schedules).some((s) => s.procedureId === id))
        throw new WorkflowError(
          "procedure_in_use",
          "Delete its schedules before deleting this procedure",
          409,
        );
      const next = structuredClone(this.manifest);
      delete next.procedures[id];
      await this.persist(next);
      this.deps.events.publish("workflow.procedure.deleted", { id });
    });
  }

  async startProcedure(
    id: string,
    input: unknown,
    actor: WorkflowActor,
    options: { metadata?: Record<string, unknown>; controlToken?: string } = {},
  ) {
    this.assertActor(actor);
    const start = ProcedureStartSchema.parse(input);
    const procedure = this.getProcedure(id, start.version, actor);
    validateSafePayload(start.inputs);
    const validation = await validateExtractedData(procedure.inputSchema, start.inputs);
    if (!validation.valid) throw new WorkflowError("invalid_procedure_inputs", validation.error);
    const steps: WorkflowStep[] = [];
    for (const template of procedure.steps) {
      const step = substitute(template, start.inputs) as typeof template;
      if (step.kind === "assert") {
        steps.push({
          id: step.id,
          kind: "product.assert",
          input: this.validateAssertion(step.assertion),
        });
        continue;
      }
      if (step.kind === "vault_fill") {
        const { id: _, kind: __, ...input } = step;
        steps.push({ id: step.id, kind: "product.vault_fill", input: VaultInput.parse(input) });
        continue;
      }
      const commands = requestSchema.parse(step.input);
      this.assertStableCommands(commands);
      validateSafePayload(commands);
      if (step.review)
        steps.push({
          id: `review_${step.id}`.slice(0, 128),
          kind: "product.review",
          input: {
            proposal: ProposalSchema.parse(step.review),
            command: commands,
            actionStepId: step.id,
            timeoutMs: step.reviewTimeoutMs ?? 900000,
          },
        });
      steps.push({ id: step.id, kind: "commands", input: commands, retry: step.retry });
    }
    if (new Set(steps.map((s) => s.id)).size !== steps.length)
      throw new WorkflowError(
        "duplicate_step",
        "Compiled step IDs conflict with generated review IDs",
      );
    const run = await this.deps.runtime.create(
      {
        sessionId: start.sessionId,
        sessionOptions: start.sessionOptions,
        steps,
        controlToken: options.controlToken,
        idempotencyKey: `procedure:${id}:${start.idempotencyKey}`,
        metadata: {
          ...options.metadata,
          productProcedureId: id,
          productProcedureVersion: procedure.version,
          productProcedureDigest: procedure.digest,
          productInputDigest: digest(start.inputs),
        },
      },
      actor,
    );
    await this.deps.store.write(`workflows/bindings/${run.id}.json`, {
      ownerId: run.ownerId,
      procedureId: procedure.id,
      version: procedure.version,
      procedureDigest: procedure.digest,
      inputDigest: digest(start.inputs),
    });
    return run;
  }

  /** Only explicit selected command requests are importable; raw CDP/timeline events are not executable procedures. */
  async createFromActions(
    input: {
      name: string;
      actions: Array<{ id: string; input: unknown }>;
      inputSchema?: Record<string, unknown>;
    },
    actor: WorkflowActor,
  ) {
    if (!Array.isArray(input.actions) || input.actions.length > 100)
      throw new WorkflowError("invalid_actions", "Select at most 100 command actions");
    const steps = input.actions.map((action) => {
      const request = requestSchema.parse(action.input);
      delete request.after;
      if (request.observe?.base)
        request.observe = { ...request.observe, mode: "snapshot", base: undefined };
      return { id: ProductId.parse(action.id), kind: "commands" as const, input: request };
    });
    return this.saveProcedure({ name: input.name, steps, inputSchema: input.inputSchema }, actor);
  }

  private reviewId(runId: string, stepId: string) {
    return digest({ runId, stepId });
  }
  private async captureReviewState(ctx: StepContext) {
    const response = await ctx.execute(
      { commands: [{ command: "snapshot", interactive: true }], observe: { mode: "none" } },
      `${ctx.run.id}:${ctx.step.id}:review-state:${randomUUID()}`,
    );
    const result = (response.body.results as Array<{ ok?: boolean; snapshot?: string }>)?.[0];
    if (
      response.status >= 400 ||
      !result?.ok ||
      typeof result.snapshot !== "string" ||
      result.snapshot.length > 200000
    )
      throw this.deps.runtime.pauseError("review_state_unavailable");
    return {
      hash: digest({ snapshot: result.snapshot, page: response.body.page }),
      snapshot:
        ctx.run.sessionId && this.deps.isSensitiveSession?.(ctx.run.sessionId)
          ? "[Snapshot omitted for a sensitive session]"
          : result.snapshot,
    };
  }
  private async verifyAttachments(ctx: StepContext, proposal: ReviewRecord["proposal"]) {
    if (proposal.attachments.length && !this.deps.verifyAttachment)
      throw this.deps.runtime.pauseError("attachment_verification_unavailable");
    for (const attachment of proposal.attachments)
      await this.deps.verifyAttachment!(ctx, attachment);
  }
  private async executeReview(ctx: StepContext) {
    const input = ReviewInput.parse(ctx.step.input);
    const next = ctx.run.steps[ctx.run.steps.findIndex((s) => s.id === ctx.step.id) + 1];
    if (
      !next ||
      next.id !== input.actionStepId ||
      next.kind !== "commands" ||
      digest(next.input) !== digest(input.command)
    )
      throw new WorkflowError(
        "review_action_mismatch",
        "Review does not describe the immediately following action",
        409,
      );
    const id = this.reviewId(ctx.run.id, ctx.step.id);
    const result = await this.serial(async () => {
      let review = await this.deps.store.read<ReviewRecord>(`workflows/reviews/${id}.json`);
      if (
        review &&
        review.contentHash !==
          digest({
            proposal: input.proposal,
            command: input.command,
            actionStepId: input.actionStepId,
            preparedStateHash: review.preparedStateHash,
          })
      )
        throw new WorkflowError(
          "review_content_changed",
          "Review content changed; create a new run",
          409,
        );
      if (!review) {
        await this.verifyAttachments(ctx, input.proposal);
        const state = await this.captureReviewState(ctx);
        const contentHash = digest({
          proposal: input.proposal,
          command: input.command,
          actionStepId: input.actionStepId,
          preparedStateHash: state.hash,
        });
        review = {
          id,
          runId: ctx.run.id,
          stepId: ctx.step.id,
          ownerId: ctx.run.ownerId,
          proposal: input.proposal,
          command: input.command,
          contentHash,
          preparedStateHash: state.hash,
          preparedSnapshot: state.snapshot,
          status: "pending",
          createdAt: this.now().toISOString(),
          expiresAt: new Date(this.now().getTime() + input.timeoutMs).toISOString(),
        };
        await this.deps.store.write(`workflows/reviews/${id}.json`, review);
        this.deps.events.publish(
          "workflow.review.updated",
          { id, runId: review.runId, ownerId: review.ownerId, status: review.status },
          ctx.run.sessionId,
        );
      }
      return review;
    });
    if (result.status === "pending" && Date.parse(result.expiresAt) <= this.now().getTime()) {
      await this.expireReview(result.id);
      throw new WorkflowError("review_expired", "The submission review deadline elapsed", 409);
    }
    if (result.status === "pending" && ctx.run.sessionId)
      this.holdReview(result, ctx.run.sessionId);
    if (result.status === "expired")
      throw new WorkflowError("review_expired", "The submission review deadline elapsed", 409);
    if (result.status === "rejected")
      throw new WorkflowError("review_rejected", "The proposed action was rejected", 409);
    return result.status === "approved"
      ? { status: "succeeded" as const, output: { reviewId: id, contentHash: result.contentHash } }
      : {
          status: "paused" as const,
          reason: "review_required",
          output: { reviewId: id, contentHash: result.contentHash },
        };
  }
  private async enforceReview(ctx: StepContext) {
    const index = ctx.run.steps.findIndex((s) => s.id === ctx.step.id);
    const previous = ctx.run.steps[index - 1];
    if (ctx.step.kind !== "commands" || previous?.kind !== "product.review") return;
    const input = ReviewInput.parse(previous.input);
    const review = await this.deps.store.read<ReviewRecord>(
      `workflows/reviews/${this.reviewId(ctx.run.id, previous.id)}.json`,
    );
    const hash = digest({
      proposal: input.proposal,
      command: ctx.step.input,
      actionStepId: ctx.step.id,
      preparedStateHash: review?.preparedStateHash,
    });
    if (!review || review.status !== "approved" || !equalDigest(review.contentHash, hash))
      throw this.deps.runtime.pauseError("review_required");
    const current = await this.captureReviewState(ctx);
    if (!equalDigest(review.preparedStateHash, current.hash))
      throw this.deps.runtime.pauseError("review_state_changed_create_new_run");
    await this.verifyAttachments(ctx, input.proposal);
  }
  async listReviews(actor: WorkflowActor) {
    this.assertActor(actor);
    const rows: ReviewRecord[] = [];
    for (const file of await this.deps.store.list("workflows/reviews"))
      if (file.endsWith(".json")) {
        const row = await this.deps.store.read<ReviewRecord>(`workflows/reviews/${file}`);
        if (row && (row.ownerId === actor.id || actor.role === "operator")) rows.push(row);
      }
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async getReview(id: string, actor: WorkflowActor) {
    ProductId.parse(id);
    const review = await this.deps.store.read<ReviewRecord>(`workflows/reviews/${id}.json`);
    if (!review) throw new WorkflowError("review_not_found", "Review not found", 404);
    this.authorize(review.ownerId, actor);
    return review;
  }
  async decideReview(
    id: string,
    input: { decision: "approve" | "reject"; contentHash: string },
    actor: WorkflowActor,
  ) {
    this.assertActor(actor);
    ProductId.parse(id);
    if (actor.role !== "operator")
      throw new WorkflowError(
        "operator_required",
        "Only an authenticated operator can approve or reject a submission",
        403,
      );
    z.object({
      decision: z.enum(["approve", "reject"]),
      contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
      .strict()
      .parse(input);
    await this.expireReview(id);
    const review = await this.serial(async () => {
      const current = await this.getReview(id, actor);
      if (current.status === "expired")
        throw new WorkflowError(
          "review_expired",
          "The review deadline elapsed; prepare a new run",
          409,
        );
      if (!equalDigest(current.contentHash, input.contentHash))
        throw new WorkflowError(
          "review_content_changed",
          "Refresh the exact proposed action before deciding",
          409,
        );
      if (current.status !== "pending")
        throw new WorkflowError(
          "review_already_decided",
          "This review already has a decision",
          409,
        );
      const run = await this.deps.runtime.get(current.runId, actor);
      if (run.status !== "paused" || run.steps[run.cursor]?.id !== current.stepId)
        throw new WorkflowError("review_not_waiting", "The run is not waiting on this review", 409);
      const next: ReviewRecord = {
        ...current,
        status: input.decision === "approve" ? "approved" : "rejected",
        decidedAt: this.now().toISOString(),
        decisionBy: actor.id,
      };
      await this.deps.store.write(`workflows/reviews/${id}.json`, next);
      return next;
    });
    this.releaseReviewHold(id);
    this.deps.events.publish("workflow.review.updated", {
      id,
      runId: review.runId,
      ownerId: review.ownerId,
      status: review.status,
    });
    // A durable decision survives a failed resume. The operator can resume the run explicitly.
    if (review.status === "approved") await this.deps.runtime.resume(review.runId, actor);
    else await this.deps.runtime.cancel(review.runId, actor);
    return review;
  }

  private validateAssertion(input: unknown): Assertion {
    const assertion = AssertionSchema.parse(input);
    const request = requestSchema.parse({ commands: [assertion.command] });
    if (!request.commands.every((c) => readOnly.has(c.command)))
      throw new WorkflowError(
        "mutating_assertion",
        "Assertions must use a read-only browser command",
      );
    if (request.commands.some((c) => c.command === "get" && c.what === "value"))
      throw new WorkflowError(
        "sensitive_assertion",
        "Form values are excluded from completion receipts",
      );
    if (["equals", "contains"].includes(assertion.operator) && assertion.expected === undefined)
      throw new WorkflowError("missing_expected", "This assertion requires an expected value");
    validateSafePayload(assertion);
    return assertion;
  }
  private async executeAssertion(ctx: StepContext) {
    const assertion = this.validateAssertion(ctx.step.input);
    const attempt =
      (ctx.run.results.find((r) => r.stepId === ctx.step.id) as { attempts?: number })?.attempts ??
      0;
    const response = await ctx.execute(
      { commands: [assertion.command], observe: { mode: "none" } },
      `${ctx.run.id}:${ctx.step.id}:observe:${attempt}`,
    );
    const body = response.body;
    const results = body.results as Array<{ ok?: boolean; masked?: boolean }> | undefined;
    const available =
      response.status < 400 && results?.[0]?.ok === true && results[0].masked !== true;
    const actual = available ? atPath(body, assertion.path) : undefined;
    const matches =
      assertion.operator === "exists"
        ? actual !== undefined && actual !== null
        : assertion.operator === "not_exists"
        ? actual === undefined || actual === null
        : assertion.operator === "equals"
        ? canonical(actual) === canonical(assertion.expected)
        : typeof actual === "string" && typeof assertion.expected === "string"
        ? actual.includes(assertion.expected)
        : Array.isArray(actual) &&
          actual.some((v) => canonical(v) === canonical(assertion.expected));
    const result: AssertionResult = {
      id: assertion.id,
      label: assertion.label,
      status: available ? (matches ? "passed" : "failed") : "unavailable",
      operator: assertion.operator,
      expected: redactArguments(assertion.expected),
      actual: redactArguments(actual),
      observedAt: this.now().toISOString(),
      source: "browser-command",
      url: typeof (body.page as any)?.url === "string" ? (body.page as any).url : undefined,
    };
    if (!available) result.reason = "Browser observation failed or was masked";
    const isSensitive = () =>
      Boolean(ctx.run.sessionId && this.deps.isSensitiveSession?.(ctx.run.sessionId));
    const canSaveEvidence = () =>
      Boolean(
        ctx.run.sessionId &&
          !isSensitive() &&
          this.deps.evidenceAllowed?.(ctx.run.sessionId) === true,
      );
    const sensitive = isSensitive();
    if (sensitive) {
      result.actual = "[redacted sensitive session]";
      result.expected = "[redacted sensitive session]";
    }
    if (
      assertion.evidence === "screenshot" &&
      available &&
      ctx.run.sessionId &&
      !sensitive &&
      this.deps.evidenceAllowed?.(ctx.run.sessionId) === true
    ) {
      const screenshot = await ctx.execute(
        { commands: [{ command: "screenshot", format: "png" }], observe: { mode: "none" } },
        `${ctx.run.id}:${ctx.step.id}:evidence:${attempt}`,
      );
      const frame = (screenshot.body.results as any[])?.[0];
      if (
        canSaveEvidence() &&
        frame?.ok &&
        typeof frame.data === "string" &&
        frame.data.length <= 8_000_000
      ) {
        const artifactId = digest({ runId: ctx.run.id, stepId: ctx.step.id });
        const bytes = Buffer.from(frame.data, "base64");
        await this.deps.store.write(`workflows/evidence/${artifactId}.json`, {
          ownerId: ctx.run.ownerId,
          runId: ctx.run.id,
          mime: "image/png",
          data: frame.data,
        });
        if (canSaveEvidence())
          result.evidence = {
            type: "screenshot",
            artifactId,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          };
        else await this.deps.store.remove(`workflows/evidence/${artifactId}.json`);
      } else result.reason = "Assertion observed; optional screenshot unavailable";
    } else if (assertion.evidence === "screenshot")
      result.reason = "Persisted screenshot evidence is disabled for this session";
    // Privacy may change while the command or screenshot is in flight.
    if (isSensitive()) {
      result.actual = "[redacted sensitive session]";
      result.expected = "[redacted sensitive session]";
    }
    return { status: "succeeded" as const, output: { assertion: result } };
  }

  async refreshReceipt(run: WorkflowRun): Promise<CompletionReceipt> {
    return this.serial(async () => {
      const assertions = run.results
        .map((r) => (r.output as { assertion?: AssertionResult })?.assertion)
        .filter((r): r is AssertionResult => Boolean(r));
      const status: CompletionReceipt["status"] =
        run.status === "uncertain"
          ? "uncertain"
          : ["failed", "cancelled"].includes(run.status)
          ? "failed"
          : run.status !== "completed"
          ? "waiting"
          : assertions.some((a) => a.status === "failed")
          ? "failed"
          : assertions.length > 0 && assertions.every((a) => a.status === "passed")
          ? "verified"
          : "uncertain";
      const previous = await this.deps.store.read<CompletionReceipt>(
        `workflows/receipts/${run.id}.json`,
      );
      if (previous && previous.revision > run.revision) return previous;
      const receipt: CompletionReceipt = {
        id: run.id,
        runId: run.id,
        sessionId: run.sessionId,
        ownerId: run.ownerId,
        procedureId: run.metadata?.productProcedureId as string | undefined,
        procedureVersion: run.metadata?.productProcedureVersion as number | undefined,
        status,
        assertions,
        runStatus: run.status,
        revision: run.revision,
        createdAt: previous?.createdAt ?? this.now().toISOString(),
        updatedAt: this.now().toISOString(),
        summary:
          status === "verified"
            ? `${assertions.length} declared outcome checks passed`
            : status === "waiting"
            ? `Run is ${run.status}`
            : status === "failed"
            ? "Run or declared outcome check failed"
            : "Completion has not been verified",
      };
      await this.deps.store.write(`workflows/receipts/${run.id}.json`, receipt);
      this.deps.events.publish(
        "workflow.receipt.updated",
        {
          id: receipt.id,
          ownerId: receipt.ownerId,
          procedureId: receipt.procedureId,
          status: receipt.status,
          updatedAt: receipt.updatedAt,
        },
        run.sessionId,
      );
      return receipt;
    });
  }
  async getReceipt(runId: string, actor: WorkflowActor) {
    const run = await this.deps.runtime.get(ProductId.parse(runId), actor);
    this.authorize(run.ownerId, actor);
    return this.refreshReceipt(run);
  }
  async listReceipts(actor: WorkflowActor) {
    this.assertActor(actor);
    const rows: CompletionReceipt[] = [];
    for (const file of await this.deps.store.list("workflows/receipts"))
      if (file.endsWith(".json")) {
        const row = await this.deps.store.read<CompletionReceipt>(`workflows/receipts/${file}`);
        if (row && (row.ownerId === actor.id || actor.role === "operator")) rows.push(row);
      }
    return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async getEvidence(id: string, actor: WorkflowActor) {
    ProductId.parse(id);
    const evidence = await this.deps.store.read<{ ownerId: string; mime: string; data: string }>(
      `workflows/evidence/${id}.json`,
    );
    if (!evidence) throw new WorkflowError("evidence_not_found", "Evidence not found", 404);
    this.authorize(evidence.ownerId, actor);
    return { mime: evidence.mime, data: Buffer.from(evidence.data, "base64") };
  }

  listSchedules(actor: WorkflowActor) {
    this.assertActor(actor);
    return Object.values(this.manifest.schedules)
      .filter((s) => s.ownerId === actor.id || actor.role === "operator")
      .map(({ webhookHash: _, ...schedule }) => structuredClone(schedule));
  }
  async putSchedule(input: unknown, actor: WorkflowActor) {
    this.assertActor(actor);
    const parsed = ScheduleInputSchema.parse(input);
    const procedure = this.getProcedure(parsed.procedureId, parsed.version, actor);
    validateSafePayload(parsed);
    const inputs = await validateExtractedData(procedure.inputSchema, parsed.inputs);
    if (!inputs.valid) throw new WorkflowError("invalid_procedure_inputs", inputs.error);
    if (parsed.trigger.kind === "watcher") {
      if (!this.deps.authorizeWatcher)
        throw new WorkflowError(
          "watcher_authorization_unavailable",
          "Watcher triggers require an access-control adapter",
          503,
        );
      await this.deps.authorizeWatcher(parsed.trigger.watcherId, actor);
    }
    const token =
      parsed.trigger.kind === "webhook" ? randomBytes(32).toString("base64url") : undefined;
    return this.serial(async () => {
      const id = parsed.id ?? randomUUID();
      const previous = this.manifest.schedules[id];
      if (previous) this.authorize(previous.ownerId, actor);
      const record: ScheduleRecord = {
        ...parsed,
        id,
        ownerId: procedure.ownerId,
        createdAt: previous?.createdAt ?? this.now().toISOString(),
        updatedAt: this.now().toISOString(),
        webhookHash: token ? digest(token) : undefined,
      };
      record.nextRunAt = nextScheduledAt(record, this.now());
      const next = structuredClone(this.manifest);
      next.schedules[id] = record;
      await this.persist(next);
      const { webhookHash: _, ...safe } = record;
      return { ...safe, ...(token ? { webhookToken: token } : {}) };
    });
  }
  async removeSchedule(id: string, actor: WorkflowActor) {
    return this.serial(async () => {
      const existing = this.manifest.schedules[ProductId.parse(id)];
      if (!existing) throw new WorkflowError("schedule_not_found", "Schedule not found", 404);
      this.authorize(existing.ownerId, actor);
      const next = structuredClone(this.manifest);
      delete next.schedules[id];
      await this.persist(next);
    });
  }
  async scheduleHistory(id: string, actor: WorkflowActor) {
    const schedule = this.manifest.schedules[ProductId.parse(id)];
    if (!schedule) throw new WorkflowError("schedule_not_found", "Schedule not found", 404);
    this.authorize(schedule.ownerId, actor);
    return (await this.deps.store.readLines<TriggerRecord>(`workflows/triggers/${id}.jsonl`)).slice(
      -500,
    );
  }
  async webhook(id: string, token: string, eventId: string) {
    const schedule = this.manifest.schedules[ProductId.parse(id)];
    if (
      !schedule ||
      schedule.trigger.kind !== "webhook" ||
      !schedule.webhookHash ||
      !equalDigest(schedule.webhookHash, digest(token))
    )
      throw new WorkflowError("invalid_webhook", "Invalid webhook credentials", 401);
    if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(eventId))
      throw new WorkflowError("invalid_event_id", "A bounded unique event ID is required");
    return this.fire(schedule, `webhook:${eventId}`, digest(token));
  }
  private async onWatcher(eventId: string, data: unknown) {
    const event = data as { watcherId?: string; matched?: boolean };
    for (const schedule of Object.values(this.manifest.schedules))
      if (
        schedule.trigger.kind === "watcher" &&
        schedule.trigger.watcherId === event.watcherId &&
        (!schedule.trigger.onlyMatched || event.matched === true)
      )
        await this.fire(schedule, `watcher:${eventId}`);
  }
  private async fire(
    schedule: ScheduleRecord,
    key: string,
    webhookHash?: string,
  ): Promise<TriggerRecord> {
    return this.serial(async () => {
      const current = this.manifest.schedules[schedule.id];
      if (!current) throw new WorkflowError("schedule_not_found", "Schedule no longer exists", 404);
      if (webhookHash && (!current.webhookHash || !equalDigest(current.webhookHash, webhookHash)))
        throw new WorkflowError("invalid_webhook", "Webhook credentials changed", 401);
      const id = digest({ scheduleId: schedule.id, key });
      const path = `workflows/deliveries/${id}.json`;
      const previous = await this.deps.store.read<TriggerRecord>(path);
      if (previous && previous.state !== "pending") return previous;
      const record: TriggerRecord = previous ?? {
        id,
        scheduleId: schedule.id,
        ownerId: current.ownerId,
        key,
        state: "pending",
        at: this.now().toISOString(),
        deadlineAt: new Date(this.now().getTime() + current.deadlineSeconds * 1000).toISOString(),
        definition: {
          procedureId: current.procedureId,
          version: current.version,
          inputs: structuredClone(current.inputs),
          sessionId: current.sessionId,
          sessionOptions: structuredClone(current.sessionOptions),
        },
      };
      const actor = this.systemActor(record.ownerId);
      const runs = await this.deps.runtime.list(actor);
      const admitted = runs.find((r) => r.metadata?.productDeliveryId === id);
      const active = runs.filter(
        (r) => r.metadata?.productScheduleId === schedule.id && !terminal.has(r.status),
      );
      if (admitted) {
        record.runId = admitted.id;
        record.state = "started";
        if (Date.parse(record.deadlineAt) < this.now().getTime() && !terminal.has(admitted.status))
          await this.deps.runtime.cancel(admitted.id, actor);
      } else if (Date.parse(record.deadlineAt) < this.now().getTime()) {
        record.state = "skipped";
        record.reason = "delivery_deadline_expired";
      } else if (
        !current.enabled ||
        current.ownerId !== record.ownerId ||
        active.length >= current.maxConcurrent
      ) {
        record.state = "skipped";
        record.reason = !current.enabled
          ? "schedule_disabled"
          : current.ownerId !== record.ownerId
          ? "schedule_owner_changed"
          : "concurrency_limit";
      } else {
        await this.deps.store.write(path, record);
        try {
          // Use the same delivery key after a crash; the durable runner deduplicates creation.
          if (!record.definition)
            throw new WorkflowError(
              "delivery_definition_missing",
              "Interrupted delivery has no immutable definition",
            );
          const definition = record.definition;
          const procedure = this.getProcedure(definition.procedureId, definition.version, actor);
          const run = await this.startProcedure(
            procedure.id,
            {
              version: procedure.version,
              inputs: definition.inputs,
              sessionId: definition.sessionId,
              sessionOptions: definition.sessionOptions,
              idempotencyKey: id,
            },
            actor,
            { metadata: { productScheduleId: schedule.id, productDeliveryId: id } },
          );
          record.runId = run.id;
          record.state = "started";
        } catch (error) {
          record.state = "failed";
          record.reason = error instanceof WorkflowError ? error.code : "run_creation_failed";
        }
      }
      await this.deps.store.write(path, record);
      await this.deps.store.append(`workflows/triggers/${schedule.id}.jsonl`, record);
      return record;
    });
  }
  tick(): Promise<void> {
    if (this.tickTask) return this.tickTask;
    this.tickTask = this.runTick().finally(() => {
      this.tickTask = undefined;
    });
    return this.tickTask;
  }
  private async runTick() {
    if (this.closed) return;
    for (const id of this.reviewHolds.keys()) await this.expireReview(id);
    for (const schedule of Object.values(this.manifest.schedules)) {
      if (
        !schedule.enabled ||
        !schedule.nextRunAt ||
        Date.parse(schedule.nextRunAt) > this.now().getTime()
      )
        continue;
      const due = schedule.nextRunAt;
      const lateness = this.now().getTime() - Date.parse(due);
      if (lateness <= schedule.maxLatenessSeconds * 1000 || schedule.missedRun === "run_once")
        await this.fire(schedule, `schedule:${due}`);
      else
        await this.deps.store.append(`workflows/triggers/${schedule.id}.jsonl`, {
          id: digest({ id: schedule.id, due }),
          scheduleId: schedule.id,
          ownerId: schedule.ownerId,
          key: `schedule:${due}`,
          state: "skipped",
          at: this.now().toISOString(),
          deadlineAt: due,
          reason: "missed_deadline",
        } satisfies TriggerRecord);
      await this.serial(async () => {
        const next = structuredClone(this.manifest);
        const current = next.schedules[schedule.id];
        if (!current || current.nextRunAt !== due) return;
        if (current.trigger.kind === "daily")
          current.lastLocalDate = localParts(new Date(due), current.trigger.timezone).date;
        current.nextRunAt = nextScheduledAt(current, this.now());
        await this.persist(next);
      });
    }
    // Resume pending deliveries after a crash and enforce explicit run deadlines.
    for (const file of await this.deps.store.list("workflows/deliveries"))
      if (file.endsWith(".json")) {
        const record = await this.deps.store.read<TriggerRecord>(`workflows/deliveries/${file}`);
        if (!record) continue;
        const schedule = this.manifest.schedules[record.scheduleId];
        if (record.state === "pending" && schedule) await this.fire(schedule, record.key);
        if (
          record.state === "started" &&
          record.runId &&
          Date.parse(record.deadlineAt) < this.now().getTime()
        ) {
          const actor = this.systemActor(record.ownerId);
          const run = await this.deps.runtime.get(record.runId, actor);
          if (!terminal.has(run.status)) await this.deps.runtime.cancel(run.id, actor);
        }
      }
  }

  async startReplay(input: unknown, actor: WorkflowActor): Promise<ReplayRecord> {
    this.assertActor(actor);
    if (!this.deps.releaseReplaySession)
      throw new WorkflowError(
        "replay_cleanup_unavailable",
        "Regression replay requires a dedicated-session cleanup adapter",
        503,
      );
    const parsed = ReplayInputSchema.parse(input);
    const baseline = await this.deps.runtime.get(parsed.baselineRunId, actor);
    this.authorize(baseline.ownerId, actor);
    const receipt = await this.refreshReceipt(baseline);
    if (receipt.status !== "verified" || !receipt.procedureId || !receipt.procedureVersion)
      throw new WorkflowError("invalid_baseline", "Replay requires a verified procedure run", 409);
    if (baseline.metadata?.productInputDigest !== digest(parsed.inputs))
      throw new WorkflowError(
        "replay_input_mismatch",
        "Replay inputs must match the verified baseline",
        409,
      );
    const origins = parsed.allowedOrigins.map((raw) => {
      const url = new URL(raw);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      )
        throw new WorkflowError(
          "invalid_fixture_origin",
          "Use HTTP(S) origins without credentials, paths or queries",
        );
      return url.origin;
    });
    if (origins.some((origin) => !this.deps.replayOrigins?.includes(origin)))
      throw new WorkflowError(
        "fixture_not_configured",
        "Every replay origin must be an operator-configured owned fixture",
        403,
      );
    if (parsed.allowMutations && actor.role !== "operator")
      throw new WorkflowError(
        "operator_required",
        "Only operators can enable fixture mutations",
        403,
      );
    const procedure = this.getProcedure(receipt.procedureId, receipt.procedureVersion, actor);
    const binding = await this.deps.store.read<{
      ownerId: string;
      procedureId: string;
      version: number;
      procedureDigest: string;
      inputDigest: string;
    }>(`workflows/bindings/${baseline.id}.json`);
    if (
      !binding ||
      binding.ownerId !== baseline.ownerId ||
      binding.procedureId !== procedure.id ||
      binding.version !== procedure.version ||
      binding.procedureDigest !== procedure.digest ||
      binding.inputDigest !== digest(parsed.inputs)
    )
      throw new WorkflowError(
        "invalid_baseline",
        "Baseline is not bound to an immutable workflow execution",
        409,
      );
    // Existing profiles, saved logins, extensions and user scripts are deliberately excluded.
    const options = parsed.candidate.sessionOptions;
    const allowedOptions = new Set(["headless", "dimensions", "timezone", "egress"]);
    if (Object.keys(options).some((key) => !allowedOptions.has(key)))
      throw new WorkflowError(
        "unsafe_replay_session",
        "Replay sessions may only specify runtime and emulation options",
      );
    for (const template of procedure.steps) {
      if (template.kind === "vault_fill")
        throw new WorkflowError(
          "unsafe_replay_command",
          "Regression replays cannot retrieve account secrets",
        );
      if (template.kind !== "commands") continue;
      const request = requestSchema.parse(substitute(template.input, parsed.inputs));
      for (const command of request.commands) {
        if (["eval", "tab", "upload", "pdf"].includes(command.command))
          throw new WorkflowError(
            "unsafe_replay_command",
            "Replay excludes scripts, tab creation, uploads and PDF generation",
          );
        if (
          !parsed.allowMutations &&
          !readOnly.has(command.command) &&
          command.command !== "navigate"
        )
          throw new WorkflowError(
            "replay_mutation_disabled",
            "Enable fixture mutations explicitly to replay this procedure",
          );
        if (command.command === "navigate" && !origins.includes(new URL(command.url).origin))
          throw new WorkflowError(
            "replay_origin_mismatch",
            "Procedure navigation is outside the selected fixtures",
          );
      }
    }
    const run = await this.startProcedure(
      procedure.id,
      {
        version: procedure.version,
        inputs: parsed.inputs,
        sessionOptions: options,
        idempotencyKey: `replay:${parsed.idempotencyKey}`,
      },
      actor,
      {
        metadata: {
          productReplay: true,
          productReplayOrigins: origins,
          productReplayBaseline: baseline.id,
        },
      },
    );
    const id = run.id;
    const existing = await this.deps.store.read<ReplayRecord>(`workflows/replays/${id}.json`);
    if (existing) return existing;
    const record: ReplayRecord = {
      id,
      ownerId: actor.id,
      baselineRunId: baseline.id,
      candidateRunId: run.id,
      candidateLabel: parsed.candidate.label,
      procedureId: procedure.id,
      procedureVersion: procedure.version,
      allowedOrigins: origins,
      createdAt: this.now().toISOString(),
      status: "running",
      differences: [],
    };
    await this.deps.store.write(`workflows/replays/${id}.json`, record);
    return record;
  }
  private async guardReplay(ctx: StepContext) {
    if (ctx.run.metadata?.productReplay !== true) return;
    if (!this.deps.releaseReplaySession)
      throw new WorkflowError(
        "replay_cleanup_unavailable",
        "Regression replay requires a dedicated-session cleanup adapter",
        503,
      );
    const existing = this.replayGuards.get(ctx.run.id);
    if (existing) {
      existing.check();
      return;
    }
    const origins = z.array(z.string()).parse(ctx.run.metadata.productReplayOrigins);
    if (!origins.length || origins.some((origin) => !this.deps.replayOrigins?.includes(origin)))
      throw new WorkflowError(
        "replay_fixture_revoked",
        "Replay fixture authorization is no longer configured",
        403,
      );
    const session = ctx.session as Session;
    const pages = await session.cdpService.getAllPages();
    if (pages.length !== 1)
      throw new WorkflowError(
        "unsafe_replay_session",
        "Replay requires one isolated browser page",
        409,
      );
    const page = pages[0];
    const current = page.url();
    if (current !== "about:blank" && !origins.includes(new URL(current).origin))
      throw new WorkflowError(
        "unsafe_replay_session",
        "Replay page has left its approved fixture origins",
        409,
      );
    let release!: () => void;
    const finished = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready!: () => void;
    let rejectReady!: (e: unknown) => void;
    const started = new Promise<void>((resolve, reject) => {
      ready = resolve;
      rejectReady = reject;
    });
    let check = () => {};
    const task = withNavigationPolicy(
      page,
      async (policy) => {
        check = () => policy.throwIfBlocked();
        ready();
        await finished;
      },
      {
        allowedOrigins: origins,
        allowPrivateNetworks: this.deps.replayAllowPrivateNetworks ?? false,
      },
    ).then(() => undefined);
    void task
      .catch(async (error) => {
        rejectReady(error);
        this.deps.onError?.(error);
        await this.deps.store.write(`workflows/replay-violations/${ctx.run.id}.json`, {
          blocked: true,
        });
      })
      .finally(() => this.replayGuards.delete(ctx.run.id));
    this.replayGuards.set(ctx.run.id, {
      sessionId: session.id,
      release,
      task,
      check: () => check(),
    });
    await started;
    await this.deps.store.write(`workflows/replay-runtime/${ctx.run.id}.json`, {
      observedBrowserVersion: await session.cdpService.getBrowserInstance()?.version(),
      runtimeRevision: process.env.STEEL_BUILD_REVISION,
    });
  }
  async getReplay(id: string, actor: WorkflowActor): Promise<ReplayRecord> {
    ProductId.parse(id);
    const record = await this.deps.store.read<ReplayRecord>(`workflows/replays/${id}.json`);
    if (!record) throw new WorkflowError("replay_not_found", "Replay not found", 404);
    this.authorize(record.ownerId, actor);
    const candidate = await this.getReceipt(record.candidateRunId, actor);
    const baseline = await this.getReceipt(record.baselineRunId, actor);
    if (!terminal.has(candidate.runStatus) && candidate.runStatus !== "uncertain") return record;
    record.differences = [];
    for (const expected of baseline.assertions) {
      const actual = candidate.assertions.find((a) => a.id === expected.id);
      if (
        !actual ||
        actual.status !== expected.status ||
        canonical(actual.actual) !== canonical(expected.actual)
      )
        record.differences.push({
          assertionId: expected.id,
          baseline: expected.actual,
          candidate: actual?.actual,
          reason: !actual
            ? "missing_observation"
            : actual.status !== expected.status
            ? "assertion_status_changed"
            : "observed_value_changed",
        });
    }
    const runtime = await this.deps.store.read<{
      observedBrowserVersion?: string;
      runtimeRevision?: string;
    }>(`workflows/replay-runtime/${id}.json`);
    Object.assign(record, runtime ?? {});
    if (await this.deps.store.read(`workflows/replay-violations/${id}.json`))
      record.differences.push({
        assertionId: "network-policy",
        baseline: "allowed fixture requests",
        candidate: "blocked request",
        reason: "fixture_origin_violation",
      });
    record.status =
      candidate.status === "uncertain" || candidate.status === "waiting"
        ? "inconclusive"
        : candidate.status === "verified" && record.differences.length === 0
        ? "passed"
        : "regressed";
    await this.deps.store.write(`workflows/replays/${id}.json`, record);
    return record;
  }
  async listReplays(actor: WorkflowActor) {
    this.assertActor(actor);
    const rows: ReplayRecord[] = [];
    for (const file of await this.deps.store.list("workflows/replays"))
      if (file.endsWith(".json")) {
        const row = await this.deps.store.read<ReplayRecord>(`workflows/replays/${file}`);
        if (row && (row.ownerId === actor.id || actor.role === "operator"))
          rows.push(await this.getReplay(row.id, actor));
      }
    return rows;
  }

  exportResources(actor: WorkflowActor) {
    this.assertActor(actor);
    return {
      schemaVersion: 1 as const,
      procedures: Object.values(this.manifest.procedures)
        .flat()
        .filter((p) => p.ownerId === actor.id),
      schedules: Object.values(this.manifest.schedules)
        .filter((s) => s.ownerId === actor.id)
        .map(({ webhookHash: _, ...s }) => ({ ...s, enabled: false })),
    };
  }
  async validateResources(value: unknown, actor: WorkflowActor) {
    this.assertActor(actor);
    const parsed = z
      .object({
        schemaVersion: z.literal(1),
        procedures: z.array(z.unknown()).max(10000),
        schedules: z.array(z.unknown()).max(1000),
      })
      .strict()
      .parse(value);
    const procedures: ProcedureVersion[] = [];
    for (const raw of parsed.procedures) {
      const p = raw as ProcedureVersion;
      const { version, ownerId, createdAt, digest: storedDigest, ...definition } = p;
      const input = await this.validateProcedure(definition);
      ProductId.parse(p.id);
      z.number().int().positive().parse(version);
      z.string().datetime().parse(createdAt);
      if (ownerId !== actor.id)
        throw new WorkflowError(
          "restore_owner_mismatch",
          "Restore requires an explicitly matching owner",
          403,
        );
      if (!equalDigest(storedDigest, digest(definition)))
        throw new WorkflowError(
          "restore_digest_mismatch",
          "Procedure definition digest does not match",
        );
      procedures.push({ ...input, id: p.id, version, ownerId, createdAt, digest: storedDigest });
    }
    const keys = procedures.map((p) => `${p.id}:${p.version}`);
    if (new Set(keys).size !== keys.length)
      throw new WorkflowError("duplicate_restore_version", "Duplicate procedure version in backup");
    const schedules: ScheduleRecord[] = [];
    for (const raw of parsed.schedules) {
      const s = raw as ScheduleRecord;
      const {
        ownerId,
        createdAt,
        updatedAt,
        nextRunAt: _,
        lastLocalDate: __,
        webhookHash: ___,
        ...definition
      } = s;
      const input = ScheduleInputSchema.parse(definition);
      if (ownerId !== actor.id)
        throw new WorkflowError("restore_owner_mismatch", "Schedule owner differs", 403);
      ProductId.parse(s.id);
      if (!procedures.some((p) => p.id === s.procedureId && p.version === s.version))
        throw new WorkflowError(
          "restore_missing_procedure",
          "Schedule references a missing procedure version",
        );
      schedules.push({ ...input, id: s.id, ownerId, createdAt, updatedAt, enabled: false });
    }
    return { schemaVersion: 1 as const, procedures, schedules };
  }
  async importResources(value: unknown, actor: WorkflowActor, conflict: "fail" | "skip" = "fail") {
    const data = await this.validateResources(value, actor);
    return this.serial(async () => {
      const next = structuredClone(this.manifest);
      let imported = 0;
      let importedSchedules = 0;
      for (const id of new Set(data.procedures.map((p) => p.id))) {
        const prior = next.procedures[id];
        if (prior) {
          if (conflict === "skip") continue;
          throw new WorkflowError("restore_conflict", `Procedure ${id} already exists`, 409);
        }
        next.procedures[id] = data.procedures
          .filter((v) => v.id === id)
          .sort((a, b) => a.version - b.version);
        imported++;
      }
      for (const s of data.schedules) {
        if (next.schedules[s.id]) {
          if (conflict === "skip") continue;
          throw new WorkflowError("restore_conflict", `Schedule ${s.id} already exists`, 409);
        }
        next.schedules[s.id] = s;
        importedSchedules++;
      }
      await this.persist(next);
      return { importedProcedures: imported, importedSchedules };
    });
  }
}
