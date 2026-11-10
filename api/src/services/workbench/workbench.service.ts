import { createHash, randomUUID } from "node:crypto";
import type { PlatformStore } from "../platform/store.js";
import { redactArguments } from "../handoff/agent-feature-utils.js";
import { explainState } from "./explanation.js";
import { recoveryCommands } from "./recovery-commands.js";
import { WorkbenchError } from "./errors.js";
export { WorkbenchError } from "./errors.js";
import type {
  InboxCard,
  KnowledgeInput,
  RecoveryKnowledge,
  RecoveryStep,
  SourceAction,
  WorkbenchActor,
  WorkbenchAdapters,
  WorkSource,
} from "./types.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (code: string, message: string, status = 409): never => {
  throw new WorkbenchError(status, code, message);
};
export function redactNote(value: string): string {
  return value
    .slice(0, 8000)
    .replace(/\b(Bearer\s+)[\w.+\/-]+/gi, "$1[redacted]")
    .replace(
      /\b(password|passwd|secret|token|api[ _-]?key|verification[ _-]?code|otp)\s*(?:is\s+|[:=]\s*)[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}/g, "[redacted]")
    .replace(/\b\d{6}\b/g, "[redacted]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/([?&](?:token|key|secret|password|code|auth)[^=\s]*=)[^&#\s]+/gi, "$1[redacted]");
}
function redacted(value: unknown): unknown {
  const safe = redactArguments(value);
  const visit = (v: unknown): unknown =>
    typeof v === "string"
      ? redactNote(v)
      : Array.isArray(v)
      ? v.map(visit)
      : v && typeof v === "object"
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, visit(x)]))
      : v;
  return visit(safe);
}
function origin(value: string): string {
  try {
    const u = new URL(value);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) throw new Error();
    return u.origin;
  } catch {
    return fail("invalid_origin", "An HTTP(S) site origin without credentials is required", 400);
  }
}
interface CardState {
  sourceRevision: string;
  readAt: string | null;
  dismissedAt: string | null;
  revision: number;
}
interface Acceptance {
  id: string;
  knowledgeId: string;
  version: number;
  sessionId: string;
  actorId: string;
  at: string;
  status: "applying" | "applied" | "uncertain";
  result?: unknown;
}

export class WorkbenchService {
  private readonly locks = new Map<string, Promise<unknown>>();
  constructor(
    private readonly store: PlatformStore,
    private adapters: WorkbenchAdapters,
    private readonly publish: (
      type: string,
      value: unknown,
      sessionId?: string,
    ) => unknown = () => {},
    private readonly now: () => number = Date.now,
  ) {}
  configure(adapters: Partial<WorkbenchAdapters>) {
    this.adapters = { ...this.adapters, ...adapters };
  }
  unavailable() {
    return this.adapters.unavailable?.() ?? [];
  }
  private serial<T>(key: string, action: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(action);
    this.locks.set(key, next);
    void next
      .finally(() => {
        if (this.locks.get(key) === next) this.locks.delete(key);
      })
      .catch(() => undefined);
    return next;
  }
  private statePath(actor: WorkbenchActor, id: string) {
    return `workbench/inbox/${digest(actor.id)}/${digest(id)}.json`;
  }
  private async sources(actor: WorkbenchActor): Promise<WorkSource[]> {
    const items = await this.adapters.sources(actor);
    const unique = new Map<string, WorkSource>();
    for (const source of items) {
      if (actor.role !== "operator" && source.ownerId !== actor.id) continue;
      if (source.sessionId) {
        try {
          await this.adapters.authorize(source.sessionId, actor);
        } catch (error: any) {
          if ([403, 404].includes(error.statusCode)) continue;
          throw error;
        }
      }
      const key = `${source.kind}:${source.id}`;
      if (!unique.has(key) || unique.get(key)!.updatedAt < source.updatedAt)
        unique.set(key, source);
    }
    return [...unique.values()];
  }
  private async card(source: WorkSource, actor: WorkbenchActor): Promise<InboxCard> {
    const id = `${source.kind}:${source.id}`,
      sourceRevision = digest([source.revision, source.status, source.updatedAt]);
    const stored = await this.store.read<CardState>(this.statePath(actor, id));
    const state =
      stored?.sourceRevision === sourceRevision
        ? stored
        : { sourceRevision, readAt: null, dismissedAt: null, revision: 0 };
    return {
      ...source,
      title: redactNote(source.title),
      description: source.description ? redactNote(source.description) : undefined,
      details: redacted(source.details),
      id,
      sourceId: source.id,
      sourceRevision,
      revision: digest([sourceRevision, state]),
      readAt: state.readAt,
      dismissedAt: state.dismissedAt,
    };
  }
  async inbox(
    actor: WorkbenchActor,
    options: { includeDismissed?: boolean; status?: string; limit?: number } = {},
  ) {
    const cards = await Promise.all(
      (await this.sources(actor)).map((item) => this.card(item, actor)),
    );
    return cards
      .filter(
        (item) =>
          (options.includeDismissed || !item.dismissedAt) &&
          (!options.status || item.status === options.status),
      )
      .sort(
        (a, b) => Number(!!a.readAt) - Number(!!b.readAt) || b.updatedAt.localeCompare(a.updatedAt),
      )
      .slice(0, Math.min(options.limit ?? 100, 500));
  }
  private async current(id: string, actor: WorkbenchActor, revision: string) {
    const source = (await this.sources(actor)).find((item) => `${item.kind}:${item.id}` === id);
    if (!source) return fail("item_not_found", "This work item is unavailable", 404);
    const card = await this.card(source, actor);
    if (card.revision !== revision)
      fail("stale_item", "This work item changed. Refresh it before acting.");
    return { source, card };
  }
  updateCard(
    id: string,
    actor: WorkbenchActor,
    input: { expectedRevision: string; read?: boolean; dismissed?: boolean },
  ) {
    return this.serial(this.statePath(actor, id), async () => {
      const { source, card } = await this.current(id, actor, input.expectedRevision);
      const now = new Date(this.now()).toISOString();
      const stored = await this.store.read<CardState>(this.statePath(actor, id));
      await this.store.write(this.statePath(actor, id), {
        sourceRevision: card.sourceRevision,
        readAt: input.read === undefined ? card.readAt : input.read ? now : null,
        dismissedAt:
          input.dismissed === undefined ? card.dismissedAt : input.dismissed ? now : null,
        revision: (stored?.revision ?? 0) + 1,
      });
      return this.card(source, actor);
    });
  }
  act(id: string, actor: WorkbenchActor, input: SourceAction & { expectedRevision: string }) {
    // One lock per source, not per viewer: conflicting decisions cannot both be admitted.
    return this.serial(`action:${id}`, async () => {
      const { source } = await this.current(id, actor, input.expectedRevision);
      if (!source.actions.includes(input.action))
        fail("invalid_transition", "That action is no longer available");
      const result = await this.adapters.perform(
        source,
        { ...input, note: input.note ? redactNote(input.note) : undefined },
        actor,
      );
      this.publish(
        "inbox.action",
        { id, action: input.action, actorId: actor.id },
        source.sessionId,
      );
      return { result, items: await this.inbox(actor) };
    });
  }
  async explanation(sessionId: string, actor: WorkbenchActor) {
    await this.adapters.authorize(sessionId, actor);
    const explanation = explainState(await this.adapters.telemetry(sessionId, actor), this.now());
    return redacted(explanation) as typeof explanation;
  }
  private knowledgePath(id: string, version?: number) {
    if (!/^[\w-]{1,100}$/.test(id))
      fail("knowledge_not_found", "Recovery knowledge not found", 404);
    return `workbench/knowledge/${id}/${version === undefined ? "current" : version}.json`;
  }
  private canRead(item: RecoveryKnowledge, actor: WorkbenchActor) {
    return (
      actor.role === "operator" || item.ownerId === actor.id || item.visibility === "workspace"
    );
  }
  private canEdit(item: RecoveryKnowledge, actor: WorkbenchActor) {
    return actor.role === "operator" || item.ownerId === actor.id;
  }
  async knowledge(id: string, actor: WorkbenchActor, version?: number) {
    const current = await this.store.read<RecoveryKnowledge>(this.knowledgePath(id));
    if (!current || !this.canRead(current, actor))
      return fail("knowledge_not_found", "Recovery knowledge not found", 404);
    const value =
      version === undefined
        ? current
        : await this.store.read<RecoveryKnowledge>(this.knowledgePath(id, version));
    if (!value) return fail("version_not_found", "Recovery knowledge version not found", 404);
    return value;
  }
  async listKnowledge(
    actor: WorkbenchActor,
    filter: { origin?: string; procedureId?: string; suggestions?: boolean } = {},
  ) {
    const site = filter.origin ? origin(filter.origin) : undefined;
    const items: Array<RecoveryKnowledge & { stale: boolean }> = [];
    for (const id of await this.store.list("workbench/knowledge")) {
      const item = await this.store.read<RecoveryKnowledge>(this.knowledgePath(id));
      if (
        item &&
        this.canRead(item, actor) &&
        (!site || item.origin === site) &&
        (!filter.procedureId || !item.procedureId || item.procedureId === filter.procedureId) &&
        (!filter.suggestions || (!item.disabled && Date.parse(item.expiresAt) > this.now()))
      )
        items.push({ ...item, stale: Date.parse(item.expiresAt) <= this.now() });
    }
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async createKnowledge(input: KnowledgeInput, actor: WorkbenchActor) {
    await this.adapters.authorize(input.sessionId, actor);
    const site = origin(input.origin);
    if ((await this.adapters.sessionOrigin(input.sessionId)) !== site)
      fail("origin_mismatch", "The recovery site must match this browser's current page origin");
    const handoff = this.adapters.handoff(input.sessionId);
    if (
      !handoff ||
      handoff.id !== input.handoffId ||
      handoff.status !== "done" ||
      !handoff.resolvedAt
    )
      fail("handoff_not_resolved", "Choose a completed handoff before saving its resolution");
    if (input.visibility === "workspace" && actor.role !== "operator")
      fail("operator_required", "Only an operator can share recovery knowledge", 403);
    const timeline = await this.adapters.timeline(input.sessionId);
    const selections = [...new Set(input.selectedSteps)];
    if (selections.length > 50) fail("too_many_steps", "Select at most 50 steps", 400);
    const steps: RecoveryStep[] = selections.map((seq) => {
      const entry = timeline.find((entry) => entry.seq === seq);
      if (
        !entry ||
        Date.parse(entry.at) < Date.parse(handoff!.requestedAt) ||
        Date.parse(entry.at) > Date.parse(handoff!.resolvedAt!)
      )
        return fail(
          "invalid_step",
          "Selected steps must belong to this handoff's resolution interval",
          400,
        );
      let args = redacted(entry.args);
      if (/type|fill|input|press/i.test(entry.tool) && args && typeof args === "object")
        args = {
          ...(args as Record<string, unknown>),
          ...Object.fromEntries(
            Object.keys(args)
              .filter((k) => /text|value|input|key/i.test(k))
              .map((k) => [k, "[redacted]"]),
          ),
        };
      return {
        seq,
        tool: redactNote(entry.tool),
        args,
        title: entry.title ? redactNote(entry.title) : undefined,
        replayable:
          !/\[redacted\]|\[truncated\]/.test(JSON.stringify(args)) &&
          /^(browser_|web_)?(navigate|click|wait|wait_for|scroll|select|select_option|commands)$/.test(
            entry.tool,
          ),
      };
    });
    const now = new Date(this.now()).toISOString();
    const item: RecoveryKnowledge = {
      id: randomUUID(),
      version: 1,
      ownerId: actor.id,
      visibility: input.visibility ?? "private",
      origin: site,
      procedureId: input.procedureId,
      title: redactNote(input.title),
      note: redactNote(input.note),
      source: {
        sessionId: input.sessionId,
        handoffId: input.handoffId,
        resolvedAt: handoff!.resolvedAt!,
      },
      steps,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(
        this.now() + Math.max(1, Math.min(input.expiresInDays ?? 90, 365)) * 86400000,
      ).toISOString(),
      disabled: false,
    };
    await this.store.write(this.knowledgePath(item.id, 1), item);
    await this.store.write(this.knowledgePath(item.id), item);
    this.publish("recovery.saved", { id: item.id, version: 1 }, input.sessionId);
    return item;
  }
  updateKnowledge(
    id: string,
    actor: WorkbenchActor,
    input: {
      expectedVersion: number;
      title?: string;
      note?: string;
      disabled?: boolean;
      expiresInDays?: number;
      steps?: RecoveryStep[];
    },
  ) {
    return this.serial(`knowledge:${id}`, async () => {
      const previous = await this.knowledge(id, actor);
      if (!this.canEdit(previous, actor))
        fail("access_denied", "This recovery knowledge belongs to another client", 403);
      if (previous.version !== input.expectedVersion)
        fail("stale_knowledge", "This recovery knowledge changed. Refresh before editing.");
      const now = new Date(this.now()).toISOString();
      const item: RecoveryKnowledge = {
        ...previous,
        version: previous.version + 1,
        title: input.title === undefined ? previous.title : redactNote(input.title),
        note: input.note === undefined ? previous.note : redactNote(input.note),
        disabled: input.disabled ?? previous.disabled,
        updatedAt: now,
        expiresAt:
          input.expiresInDays === undefined
            ? previous.expiresAt
            : new Date(this.now() + input.expiresInDays * 86400000).toISOString(),
        steps: input.steps
          ? input.steps.map((step) => ({
              ...step,
              args: redacted(step.args),
              title: step.title ? redactNote(step.title) : undefined,
              replayable:
                step.replayable && !/\[redacted\]/.test(JSON.stringify(redacted(step.args))),
            }))
          : previous.steps,
      };
      await this.store.write(this.knowledgePath(id, item.version), item);
      await this.store.write(this.knowledgePath(id), item);
      return item;
    });
  }
  deleteKnowledge(id: string, actor: WorkbenchActor, expectedVersion: number) {
    return this.serial(`knowledge:${id}`, async () => {
      const item = await this.knowledge(id, actor);
      if (!this.canEdit(item, actor))
        fail("access_denied", "This recovery knowledge belongs to another client", 403);
      if (item.version !== expectedVersion)
        fail("stale_knowledge", "This recovery knowledge changed");
      await this.store.remove(`workbench/knowledge/${id}`);
      return { deleted: true };
    });
  }
  acceptKnowledge(
    id: string,
    actor: WorkbenchActor,
    input: {
      expectedVersion: number;
      sessionId: string;
      accepted: boolean;
      idempotencyKey: string;
      controlToken?: string;
    },
  ) {
    return this.serial(`knowledge:${id}`, async () => {
      const item = await this.knowledge(id, actor);
      if (!input.accepted)
        fail("acceptance_required", "Review and explicitly accept these recovery steps first", 400);
      if (
        item.version !== input.expectedVersion ||
        item.disabled ||
        Date.parse(item.expiresAt) <= this.now()
      )
        fail(
          "stale_knowledge",
          "This recovery advice is stale or disabled. Review and update it before use.",
        );
      await this.adapters.authorize(input.sessionId, actor, input.controlToken, true);
      if ((await this.adapters.sessionOrigin(input.sessionId)) !== item.origin)
        fail("origin_mismatch", "Recovery knowledge can only apply to its exact site origin");
      if (!this.adapters.applyRecovery)
        fail("recovery_unavailable", "The durable procedure service is unavailable", 503);
      if (!item.steps.length || item.steps.some((step) => !step.replayable))
        fail(
          "review_steps",
          "Edit the recovery steps into supported, non-secret actions before applying",
        );
      // Validate before reserving an acceptance key. A schema error has not
      // executed anything and must not masquerade as an uncertain side effect.
      for (const step of item.steps) recoveryCommands(step, item.origin);
      const acceptanceId = digest([
          actor.id,
          id,
          input.expectedVersion,
          input.sessionId,
          input.idempotencyKey,
        ]),
        file = `workbench/acceptances/${acceptanceId}.json`;
      const existing = await this.store.read<Acceptance>(file);
      if (existing) {
        if (existing.status !== "applied")
          fail(
            "acceptance_uncertain",
            "A prior application needs reconciliation; it will not be replayed automatically",
          );
        return existing;
      }
      const acceptance: Acceptance = {
        id: acceptanceId,
        knowledgeId: id,
        version: item.version,
        sessionId: input.sessionId,
        actorId: actor.id,
        at: new Date(this.now()).toISOString(),
        status: "applying",
      };
      await this.store.write(file, acceptance);
      try {
        acceptance.result = redacted(
          await this.adapters.applyRecovery!(
            item,
            { sessionId: input.sessionId, controlToken: input.controlToken, acceptanceId },
            actor,
          ),
        );
        acceptance.status = "applied";
        await this.store.write(file, acceptance);
        this.publish(
          "recovery.accepted",
          { id, version: item.version, acceptanceId },
          input.sessionId,
        );
        return acceptance;
      } catch (error) {
        acceptance.status = "uncertain";
        await this.store.write(file, acceptance);
        throw error;
      }
    });
  }
  async close() {
    await Promise.allSettled([...this.locks.values()]);
  }
}
