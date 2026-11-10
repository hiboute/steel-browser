import { CreateSession } from "../../modules/sessions/sessions.schema.js";
import { createHash, randomUUID } from "node:crypto";
import type { PlatformStore } from "../platform/store.js";
import { AccessError, type Actor } from "../control/access.js";
import type { OwnershipService } from "../control/ownership.js";
import type { SessionService, StartSessionOptions } from "../session.service.js";
import type { SessionCommands } from "../commands/registry.js";
import {
  RunPauseError,
  type Run,
  type RunInput,
  type RunKind,
  type RunContext,
  type RunStep,
} from "./types.js";
import { requestSchema } from "../commands/commands.js";
import { redactArguments } from "../handoff/agent-feature-utils.js";

export const RunSessionOptions = CreateSession.pick({
  name: true,
  labels: true,
  timeout: true,
  idleTimeout: true,
  onExpire: true,
  keepAlive: true,
  egress: true,
  record: true,
  browserProfile: true,
  cookieSets: true,
  extensions: true,
  timezone: true,
  dimensions: true,
  deviceConfig: true,
  headless: true,
  queueTimeout: true,
  identityProfile: true,
  compatibilityMode: true,
  siteProfile: true,
  mobileProfile: true,
  continuityPolicy: true,
  continuityToken: true,
  frictionDetection: true,
  egressPolicy: true,
  siteScope: true,
}).strict();
const safeCommands = new Set(["snapshot", "find", "get", "is", "describe", "status"]);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class RunService {
  private outputFilters = new Set<
    (sessionId: string, output: unknown, step: RunStep) => unknown | Promise<unknown>
  >();
  registerOutputFilter(
    filter: (sessionId: string, output: unknown, step: RunStep) => unknown | Promise<unknown>,
  ) {
    this.outputFilters.add(filter);
    return () => this.outputFilters.delete(filter);
  }
  private async safeOutput(sessionId: string, step: RunStep, output: unknown) {
    if (step.kind === "commands" && this.sessions.getLaunchOptions?.(sessionId)?.privateCapture) {
      const body = output as any;
      output = {
        privateCapture: true,
        execution: body?.execution
          ? { id: body.execution.id, state: body.execution.state }
          : undefined,
        results: Array.isArray(body?.results)
          ? body.results.map((r: any) => ({
              command: r.command,
              ok: r.ok,
              effect: r.effect,
              error: r.error ? { code: r.error.code } : undefined,
            }))
          : undefined,
      };
    }
    for (const filter of this.outputFilters) output = await filter(sessionId, output, step);
    return output;
  }
  private delegated = new Map<string, string>();
  pauseError(reason: string) {
    return new RunPauseError(reason);
  }
  private records = new Map<string, Run>();
  private kinds = new Map<string, RunKind>();
  private active = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private locks = new Map<string, Promise<unknown>>();
  private hooks = new Set<(ctx: RunContext) => Promise<void>>();
  private closed = false;
  constructor(
    private store: PlatformStore,
    private sessions: SessionService,
    private commands: SessionCommands,
    private control: OwnershipService,
    private publish: (type: string, data: unknown, id?: string) => unknown,
  ) {
    this.registerKind("commands", {
      validate: (input) => {
        return requestSchema.parse(input);
      },
      replay: "ambiguous",
      execute: async (ctx) => {
        const response = await ctx.execute(ctx.step.input);
        if (response.status !== 200) throw new Error(`Commands failed (${response.status})`);
        const body = response.body;
        if (
          (body.execution as any)?.state !== "completed" ||
          (body.results as any[])?.some((r) => !r.ok)
        )
          throw new Error("Command step did not complete successfully");
        return { status: "succeeded", output: body };
      },
    });
  }
  registerKind(name: string, kind: RunKind) {
    if (this.kinds.has(name)) throw new Error(`Run kind already registered: ${name}`);
    this.kinds.set(name, kind);
  }
  beforeStep(hook: (ctx: RunContext) => Promise<void>) {
    this.hooks.add(hook);
    return () => this.hooks.delete(hook);
  }
  private replay(step: RunStep) {
    if (step.kind !== "commands") return this.kinds.get(step.kind)?.replay ?? "ambiguous";
    const input = step.input as any;
    const list = Array.isArray(input?.commands) ? input.commands : [input?.commands];
    return list.length && list.every((c) => safeCommands.has(c?.command)) ? "safe" : "ambiguous";
  }
  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const p = (this.locks.get(id) ?? Promise.resolve()).catch(() => {}).then(fn);
    this.locks.set(id, p);
    void p
      .finally(() => {
        if (this.locks.get(id) === p) this.locks.delete(id);
      })
      .catch(() => {});
    return p;
  }
  private async save(run: Run) {
    run.revision++;
    run.updatedAt = new Date().toISOString();
    await this.store.write(`runs/${run.id}.json`, run);
    this.publish("run.updated", { run: this.public(run) }, run.sessionId);
  }
  private public(run: Run) {
    const { actor, sessionOptions, idempotencyKey, creationHash, ...rest } = run;
    return {
      ...structuredClone(rest),
      steps: rest.steps.map((s) => ({ ...s, input: redactArguments(s.input) })),
      results: rest.results.map((r) => ({ ...r, output: redactArguments(r.output) })),
    } as Run;
  }
  private owned(id: string, actor: Actor) {
    const run = this.records.get(id);
    if (!run) throw new AccessError("run_not_found", "Task run not found", 404);
    if (run.ownerId !== actor.id && actor.role !== "operator")
      throw new AccessError("run_denied", "Task run belongs to another principal");
    return run;
  }
  get(id: string, actor: Actor) {
    return this.public(this.owned(id, actor));
  }
  list(actor: Actor) {
    return [...this.records.values()]
      .filter((r) => r.ownerId === actor.id || actor.role === "operator")
      .map((r) => this.public(r));
  }
  async initialize(autoStart = true) {
    for (const f of await this.store.list("runs")) {
      if (!/^[\w-]+\.json$/.test(f)) continue;
      const r = await this.store.read<Run>(`runs/${f}`);
      if (!r) continue;
      this.records.set(r.id, r);
      if (r.status === "running" || r.status === "queued") {
        const step = r.steps[r.cursor],
          result = r.results[r.cursor];
        if (result?.status === "running" && step && this.replay(step) === "ambiguous") {
          r.status = "uncertain";
          result.status = "uncertain";
          r.pauseReason = "restart_during_external_action";
        } else {
          r.status = "queued";
          delete r.pauseReason;
          if (result?.status === "running") result.status = "pending";
        }
        await this.save(r);
      }
    }
    if (autoStart) this.startRecovered();
  }
  startRecovered() {
    for (const r of this.records.values()) if (r.status === "queued") this.launch(r);
  }
  async create(input: RunInput, actor: Actor) {
    return this.serial(`create:${actor.id}`, async () => {
      if (this.closed) throw new AccessError("shutting_down", "Task runner is closing", 503);
      if (!Array.isArray(input.steps) || !input.steps.length || input.steps.length > 500)
        throw new AccessError("invalid_run", "Provide 1–500 validated steps", 400);
      if (input.sessionOptions)
        input = { ...input, sessionOptions: RunSessionOptions.parse(input.sessionOptions) };
      if (Buffer.byteLength(JSON.stringify(input)) > 2000000)
        throw new AccessError("run_too_large", "Task definition exceeds 2 MB", 413);
      if (input.sessionId && input.sessionOptions)
        throw new AccessError("invalid_run", "Use sessionId or sessionOptions", 400);
      const ids = new Set<string>();
      const steps = input.steps.map((s) => {
        if (!/^[\w.-]{1,128}$/.test(s.id) || ids.has(s.id))
          throw new AccessError("invalid_step", "Step IDs must be unique", 400);
        ids.add(s.id);
        const kind = this.kinds.get(s.kind);
        if (!kind) throw new AccessError("invalid_step_kind", `Unknown step kind: ${s.kind}`, 400);
        if (
          s.retry &&
          (!Number.isInteger(s.retry.maxAttempts) ||
            s.retry.maxAttempts < 1 ||
            s.retry.maxAttempts > 5 ||
            s.retry.delayMs < 0 ||
            s.retry.delayMs > 60000)
        )
          throw new AccessError("invalid_retry", "Invalid retry policy", 400);
        return { ...s, input: kind.validate(s.input) };
      });
      const creationHash = hash({
        steps,
        sessionId: input.sessionId,
        sessionOptions: input.sessionOptions,
        metadata: input.metadata,
      });
      if (input.idempotencyKey) {
        const old = [...this.records.values()].find(
          (r) => r.ownerId === actor.id && r.idempotencyKey === input.idempotencyKey,
        );
        if (old) {
          if (old.creationHash !== creationHash)
            throw new AccessError(
              "idempotency_conflict",
              "The request key already represents a different task",
              409,
            );
          return this.public(old);
        }
      }
      if (input.sessionId) {
        if (!this.control.canRead(input.sessionId, actor))
          throw new AccessError("session_denied", "Cannot run against another owner's browser");
      }
      const { controlToken, ...persistent } = input;
      if (controlToken && input.sessionId)
        this.control.assert(input.sessionId, actor, controlToken);
      const now = new Date().toISOString();
      const run: Run = {
        ...persistent,
        steps,
        creationHash,
        id: randomUUID(),
        ownerId: actor.id,
        actor: { ...actor },
        status: controlToken && input.sessionId ? "paused" : "queued",
        pauseReason: controlToken && input.sessionId ? "control_delegation_pending" : undefined,
        revision: 0,
        cursor: 0,
        results: steps.map((s) => ({ stepId: s.id, status: "pending", attempts: 0 })),
        createdAt: now,
        updatedAt: now,
      };
      this.records.set(run.id, run);
      await this.save(run);
      if (controlToken && input.sessionId) {
        const delegated = await this.control.transfer(input.sessionId, actor, controlToken, {
          mode: "agent",
        });
        this.delegated.set(run.id, delegated.token);
        run.status = "queued";
        delete run.pauseReason;
        await this.save(run);
      }
      this.launch(run);
      return this.public(run);
    });
  }
  private launch(run: Run) {
    if (this.active.has(run.id) || this.closed) return;
    const abort = new AbortController();
    const done = Promise.resolve()
      .then(() => this.work(run, abort.signal))
      .finally(() => this.active.delete(run.id));
    this.active.set(run.id, { abort, done });
    void done.catch(() => {});
  }
  async pauseForSession(id: string, reason: string) {
    await Promise.all(
      [...this.records.values()]
        .filter((r) => r.sessionId === id && ["running", "queued"].includes(r.status))
        .map((r) => this.pause(r.id, reason)),
    );
  }
  private async pause(id: string, reason: string) {
    const active = this.active.get(id);
    active?.abort.abort(new RunPauseError(reason));
    const r = this.records.get(id)!;
    if (r.sessionId) this.commands.reset(r.sessionId);
    if (active) await active.done;
    else {
      r.status = "paused";
      r.pauseReason = reason;
      await this.save(r);
    }
  }
  async cancel(id: string, actor: Actor) {
    const run = this.owned(id, actor);
    await this.pause(id, "cancelled");
    return this.serial(id, async () => {
      run.status = "cancelled";
      await this.save(run);
      return this.public(run);
    });
  }
  async resume(
    id: string,
    actor: Actor,
    options: {
      controlToken?: string;
      resolution?: { stepId: string; outcome: "applied" | "not_applied"; evidence: string };
    } = {},
  ) {
    return this.serial(id, async () => {
      const r = this.owned(id, actor);
      if (!["paused", "uncertain", "failed"].includes(r.status))
        throw new AccessError("run_state", "Only paused, uncertain or failed runs can resume", 409);
      if (this.active.has(id)) await this.active.get(id)!.done;
      if (options.controlToken && r.sessionId)
        this.control.assert(r.sessionId, actor, options.controlToken);
      if (r.status === "uncertain") {
        const resolution = options.resolution;
        if (
          !resolution ||
          resolution.stepId !== r.steps[r.cursor]?.id ||
          !resolution.evidence?.trim()
        )
          throw new AccessError(
            "reconciliation_required",
            "Record whether the external action applied before resuming",
            409,
          );
        const result = r.results[r.cursor];
        result.output = { reconciliation: resolution };
        if (resolution.outcome === "applied") {
          result.status = "succeeded";
          r.cursor++;
        } else result.status = "pending";
      } else if (r.results[r.cursor]) r.results[r.cursor].status = "pending";
      if (options.controlToken && r.sessionId) {
        r.status = "paused";
        r.pauseReason = "control_delegation_pending";
        await this.save(r);
        const delegated = await this.control.transfer(r.sessionId, actor, options.controlToken, {
          mode: "agent",
          ownerId: r.ownerId,
        });
        this.delegated.set(r.id, delegated.token);
      }
      r.status = "queued";
      delete r.pauseReason;
      await this.save(r);
      this.launch(r);
      return this.public(r);
    });
  }
  private async work(run: Run, signal: AbortSignal) {
    let token: string | undefined;
    let renewal: NodeJS.Timeout | undefined;
    let hold: (() => void) | undefined;
    try {
      if (!run.sessionId) {
        const created = await this.sessions.startSession({
          ...run.sessionOptions,
          credentials: run.sessionOptions?.credentials ?? {},
          _principal: run.actor,
          client: run.ownerId,
          labels: { ...run.sessionOptions?.labels, run: run.id },
          signal,
        } as StartSessionOptions);
        run.sessionId = created.id;
        await this.control.registerResource(created.id, run.ownerId);
        await this.save(run);
      }
      token = this.delegated.get(run.id);
      this.delegated.delete(run.id);
      if (token) this.control.assert(run.sessionId, run.actor, token);
      else {
        if (this.control.get(run.sessionId)) throw new RunPauseError("control_required");
        ({ token } = await this.control.acquire(run.sessionId, run.actor, {
          mode: "agent",
          ttlMs: 60000,
        }));
      }
      renewal = setInterval(
        () =>
          void this.control
            .renew(run.sessionId!, run.actor, token!, 60000)
            .catch(() => this.active.get(run.id)?.abort.abort(new RunPauseError("control_lost"))),
        20000,
      );
      renewal.unref();
      if (this.sessions.isParked(run.sessionId))
        await this.sessions.resumeSession(run.sessionId, { signal });
      signal.throwIfAborted();
      this.control.assert(run.sessionId, run.actor, token);
      const session = this.sessions.getSession(run.sessionId);
      if (!session || session.status !== "live") throw new RunPauseError("session_unavailable");
      hold = this.sessions.holdActivity(session.id);
      run.status = "running";
      delete run.pauseReason;
      await this.save(run);
      while (run.cursor < run.steps.length) {
        signal.throwIfAborted();
        const step = run.steps[run.cursor];
        const result = run.results[run.cursor];
        const kind = this.kinds.get(step.kind);
        if (!kind) throw new RunPauseError("executor_unavailable");
        const execute: RunContext["execute"] = async (body, key) => {
          this.control.assert(session.id, run.actor, token);
          signal.throwIfAborted();
          const engine = this.commands.get(session.id);
          let response = await engine.handle({
            sessionId: session.id,
            body,
            idempotencyKey: key ?? `${run.id}:${step.id}:${result.attempts}`,
          });
          while (["running", "queued"].includes((response.body.execution as any)?.state)) {
            signal.throwIfAborted();
            this.control.assert(session.id, run.actor, token);
            response = await engine.executionStatus(
              session.id,
              (response.body.execution as any).id,
            );
            if (["running", "queued"].includes((response.body.execution as any)?.state))
              await this.abortable(new Promise<void>((resolve) => setTimeout(resolve, 25)), signal);
          }
          return response;
        };
        const ctx: RunContext = {
          run,
          step,
          session,
          actor: run.actor,
          signal,
          controlToken: token!,
          execute,
        };
        for (const hook of this.hooks) await hook(ctx);
        this.control.assert(session.id, run.actor, token);
        signal.throwIfAborted();
        result.status = "running";
        result.attempts++;
        result.startedAt = new Date().toISOString();
        await this.save(run);
        try {
          const outcome = await this.abortable(kind.execute(ctx), signal);
          signal.throwIfAborted();
          if (outcome.status === "paused") {
            result.status = "paused";
            result.output = await this.safeOutput(session.id, step, outcome.output);
            run.status = "paused";
            run.pauseReason = outcome.reason ?? "input_required";
            await this.save(run);
            return;
          }
          result.status = "succeeded";
          result.output = await this.safeOutput(session.id, step, outcome.output);
          result.finishedAt = new Date().toISOString();
          run.cursor++;
          await this.save(run);
        } catch (error) {
          if (error instanceof RunPauseError || signal.aborted) throw error;
          if (this.replay(step) === "safe" && result.attempts < (step.retry?.maxAttempts ?? 1)) {
            result.status = "pending";
            await this.save(run);
            await new Promise<void>((resolve, reject) => {
              const onAbort = () => {
                clearTimeout(timer);
                reject(signal.reason);
              };
              const timer = setTimeout(
                () => {
                  signal.removeEventListener("abort", onAbort);
                  resolve();
                },
                step.retry?.delayMs ?? 0,
              );
              signal.addEventListener("abort", onAbort, { once: true });
            });
            continue;
          }
          result.status = this.replay(step) === "ambiguous" ? "uncertain" : "failed";
          result.error = "Step execution failed; inspect the session and evidence";
          run.status = result.status;
          run.pauseReason = result.status === "uncertain" ? "external_outcome_unknown" : undefined;
          await this.save(run);
          return;
        }
      }
      run.status = "completed";
      await this.save(run);
    } catch (error) {
      const result = run.results[run.cursor];
      if (result?.status === "running" && this.replay(run.steps[run.cursor]) === "ambiguous") {
        result.status = "uncertain";
        run.status = "uncertain";
      } else {
        if (result?.status === "running") result.status = "paused";
        run.status = "paused";
      }
      run.pauseReason =
        signal.reason instanceof RunPauseError
          ? signal.reason.reason
          : error instanceof RunPauseError
          ? error.reason
          : "execution_unavailable";
      await this.save(run);
    } finally {
      clearInterval(renewal);
      hold?.();
      if (token && run.sessionId)
        await this.control.release(run.sessionId, run.actor, token).catch(() => {});
    }
  }
  private abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const aborted = () => reject(signal.reason ?? new RunPauseError("cancelled"));
      signal.addEventListener("abort", aborted, { once: true });
      operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
      if (signal.aborted) aborted();
    });
  }
  async close() {
    this.closed = true;
    for (const active of this.active.values()) active.abort.abort(new RunPauseError("shutdown"));
    for (const r of this.records.values())
      if (this.active.has(r.id) && r.sessionId) this.commands.reset(r.sessionId);
    await Promise.allSettled([...this.active.values()].map((v) => v.done));
  }
}
