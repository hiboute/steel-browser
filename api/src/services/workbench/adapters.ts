import type { FastifyInstance, FastifyRequest } from "fastify";
import { activePage } from "../handoff/agent-feature-utils.js";
import { WorkbenchError } from "./workbench.service.js";
import type { RecoveryKnowledge, WorkbenchActor, WorkbenchAdapters, WorkSource } from "./types.js";
import { recoveryCommands } from "./recovery-commands.js";

/** Structural contracts keep independently registered streams decoupled. */
export interface WorkbenchAccess {
  actor(request: FastifyRequest): WorkbenchActor;
  assertRead(actor: WorkbenchActor, sessionId: string): void | Promise<void>;
  assertMutation(actor: WorkbenchActor, sessionId: string, token?: string): void | Promise<void>;
}
type RecordValue = Record<string, any>;
interface RunService {
  list(actor: WorkbenchActor): RecordValue[] | Promise<RecordValue[]>;
  resume(
    id: string,
    actor: WorkbenchActor,
    input?: {
      resolution?: { stepId: string; outcome: "applied" | "not_applied"; evidence: string };
      controlToken?: string;
    },
  ): unknown | Promise<unknown>;
  create?(input: unknown, actor: WorkbenchActor): unknown | Promise<unknown>;
}
interface WorkflowService {
  listReviews(actor: WorkbenchActor): RecordValue[] | Promise<RecordValue[]>;
  listReceipts(actor: WorkbenchActor): RecordValue[] | Promise<RecordValue[]>;
  decideReview(
    id: string,
    input: { decision: "approve" | "reject"; contentHash: string },
    actor: WorkbenchActor,
  ): unknown | Promise<unknown>;
  getProcedure(
    id: string,
    version: number | undefined,
    actor: WorkbenchActor,
  ): { id: string; version: number };
  saveProcedure(input: unknown, actor: WorkbenchActor): Promise<{ id: string; version: number }>;
  startProcedure(
    id: string,
    input: unknown,
    actor: WorkbenchActor,
    options?: { controlToken?: string },
  ): unknown | Promise<unknown>;
}
function service<T>(server: FastifyInstance, name: string): T | undefined {
  return server.hasDecorator(name) ? server.getDecorator<T>(name) : undefined;
}
function needed<T>(value: T | undefined, name: string): T {
  if (!value) throw new WorkbenchError(503, "service_unavailable", `${name} is unavailable`);
  return value;
}
export function accessOf(server: FastifyInstance) {
  return needed(service<WorkbenchAccess>(server, "access"), "Session access service");
}
const stamp = (value: RecordValue) =>
  String(value.updatedAt || value.createdAt || value.requestedAt || new Date(0).toISOString());
export const runSource = (run: RecordValue): WorkSource => ({
  kind: "run",
  id: run.id,
  sessionId: run.sessionId,
  runId: run.id,
  ownerId: run.ownerId,
  status: run.status,
  title: run.name || run.metadata?.name || `Task ${run.id.slice(0, 8)}`,
  description: run.pauseReason || run.error?.message || run.error,
  updatedAt: stamp(run),
  revision: run.revision ?? stamp(run),
  actions: [
    ...(["paused", "failed", "uncertain"].includes(run.status) ? ["retry" as const] : []),
    ...(run.sessionId ? ["open" as const] : []),
  ],
  details: {
    cursor: run.cursor,
    stepId: run.steps?.[run.cursor]?.id,
    total: run.steps?.length,
    results: run.results,
  },
});
const reviewSource = (review: RecordValue): WorkSource => ({
  kind: "review",
  id: review.id,
  sessionId: review.sessionId,
  runId: review.runId,
  ownerId: review.ownerId,
  status: review.status,
  title: review.proposal?.summary || "Review proposed action",
  description: review.proposal?.destination,
  updatedAt: stamp(review),
  revision: review.revision ?? review.contentHash,
  actions: [
    ...(["pending", "waiting"].includes(review.status)
      ? ["approve" as const, "reject" as const]
      : []),
    ...(review.sessionId ? ["open" as const] : []),
  ],
  details: {
    proposal: review.proposal,
    preparedSnapshot: review.preparedSnapshot,
    preparedStateHash: review.preparedStateHash,
    contentHash: review.contentHash,
    stepId: review.stepId,
  },
});

export function defaultWorkbenchAdapters(server: FastifyInstance): WorkbenchAdapters {
  const authorize = async (id: string, actor: WorkbenchActor, token?: string, write = false) => {
    const access = accessOf(server);
    if (write) await access.assertMutation(actor, id, token);
    else await access.assertRead(actor, id);
  };
  const sources = async (actor: WorkbenchActor): Promise<WorkSource[]> => {
    const runService = service<RunService>(server, "runs"),
      workflow = service<WorkflowService>(server, "workflowService");
    const runs = runService ? (await runService.list(actor)).map(runSource) : [];
    const reviews = workflow
      ? (await workflow.listReviews(actor)).map((review) =>
          reviewSource({
            ...review,
            sessionId: review.sessionId ?? runs.find((run) => run.id === review.runId)?.sessionId,
          }),
        )
      : [];
    const receipts: WorkSource[] = workflow
      ? (await workflow.listReceipts(actor)).map((receipt) => ({
          kind: "receipt",
          id: receipt.id || receipt.runId,
          sessionId: receipt.sessionId,
          runId: receipt.runId,
          ownerId: receipt.ownerId,
          status: receipt.status,
          title: receipt.summary || `Task ${receipt.status}`,
          description: receipt.description,
          updatedAt: stamp(receipt),
          revision: receipt.revision ?? stamp(receipt),
          actions: receipt.sessionId ? ["open"] : [],
          details: { assertions: receipt.assertions, evidence: receipt.evidence },
        }))
      : [];
    const handoffs: WorkSource[] = [];
    for (const h of server.handoffs.list()) {
      try {
        await authorize(h.sessionId, actor);
      } catch (error: any) {
        if ([403, 404].includes(error.statusCode)) continue;
        throw error;
      }
      handoffs.push({
        kind: "handoff",
        id: h.id,
        sessionId: h.sessionId,
        ownerId: (server as any).control?.owner(h.sessionId) ?? h.requestedBy,
        status: h.status,
        title: h.reason,
        description: h.instructions,
        updatedAt: h.resolvedAt || h.requestedAt,
        revision: `${h.id}:${h.status}:${h.resolvedAt}`,
        actions: [...(h.status === "waiting" ? ["answer" as const] : []), "open"],
        details: { expiresAt: h.expiresAt, note: h.note },
      });
    }
    // A receipt replaces its run's terminal summary; a pending review supplies
    // the actionable card instead of a second generic paused-task card.
    const represented = new Set(
      [...receipts, ...reviews.filter((r) => ["pending", "waiting"].includes(r.status))]
        .map((r) => r.runId)
        .filter(Boolean),
    );
    return [...handoffs, ...reviews, ...receipts, ...runs.filter((r) => !represented.has(r.id))];
  };
  return {
    authorize,
    sources,
    unavailable: () => [
      ...(!server.hasDecorator("runs") ? ["durable_runs"] : []),
      ...(!server.hasDecorator("workflowService") ? ["reviews", "receipts", "procedures"] : []),
    ],
    perform: async (source, input, actor) => {
      if (source.sessionId)
        await authorize(source.sessionId, actor, input.controlToken, input.action === "retry");
      if (source.kind === "handoff" && input.action === "answer") {
        const current = server.handoffs.get(source.sessionId!);
        if (!current || current.id !== source.id || current.status !== "waiting")
          throw new WorkbenchError(
            409,
            "stale_handoff",
            "The handoff changed before your answer arrived",
          );
        return server.handoffs.resolve(source.sessionId!, "done", actor.id, input.note, source.id);
      }
      if (source.kind === "run" && input.action === "retry")
        return needed(service<RunService>(server, "runs"), "Durable runs").resume(
          source.id,
          actor,
          { resolution: input.resolution, controlToken: input.controlToken },
        );
      if (source.kind === "review" && ["approve", "reject"].includes(input.action)) {
        const hash = (source.details as { contentHash?: string })?.contentHash;
        if (!hash || input.contentHash !== hash)
          throw new WorkbenchError(
            409,
            "stale_review",
            "Review the current immutable proposal before deciding",
          );
        return needed(
          service<WorkflowService>(server, "workflowService"),
          "Review service",
        ).decideReview(
          source.id,
          { decision: input.action as "approve" | "reject", contentHash: hash },
          actor,
        );
      }
      throw new WorkbenchError(
        409,
        "invalid_transition",
        "The work item does not support that action",
      );
    },
    telemetry: async (sessionId, actor) => {
      const live = server.sessionService.getSession(sessionId),
        session = live ?? server.sessionService.pastSessions.find((s) => s.id === sessionId);
      if (!session) throw new WorkbenchError(404, "session_not_found", "Session not found");
      const unavailable: string[] = [];
      const runService = service<RunService>(server, "runs"),
        workflow = service<WorkflowService>(server, "workflowService");
      const runs = runService
        ? (await runService.list(actor)).filter((r) => r.sessionId === sessionId).map(runSource)
        : (unavailable.push("durable_runs"), []);
      const reviews = workflow
        ? (await workflow.listReviews(actor))
            .filter((r) => r.sessionId === sessionId || runs.some((run) => run.id === r.runId))
            .map(reviewSource)
        : (unavailable.push("reviews"), []);
      const control = service<{ get(sessionId: string): unknown }>(server, "control");
      const ownership = control
        ? await control.get(sessionId)
        : (unavailable.push("ownership"), undefined);
      const entries = await server.timeline.read(sessionId, 0, 2000);
      const lastAction = entries
        .filter((entry) => !["lifecycle", "cookieset"].includes(entry.kind))
        .at(-1);
      const summaries = await server.cookieLibrary.list();
      const cookieNames = (session as { cookieSets?: string[] }).cookieSets ?? [];
      const auth = summaries
        .filter((s) => cookieNames.includes(s.name))
        .map((s) => ({ name: s.name, status: s.health?.status || "unknown" }));
      const queue = server.browserPool.queue.find((item) => item.sessionId === sessionId);
      return {
        session: session as any,
        handoff: server.handoffs.get(sessionId),
        ownership: ownership as any,
        runs,
        reviews,
        auth,
        queue,
        lastAction,
        unavailable,
      };
    },
    handoff: (id) => server.handoffs.get(id),
    timeline: (id) => server.timeline.read(id, 0, 2000),
    sessionOrigin: async (id) => {
      const session = server.sessionService.getSession(id);
      if (!session || session.status !== "live") return null;
      const page = await activePage(session);
      try {
        return page ? new URL(page.url()).origin : null;
      } catch {
        return null;
      }
    },
    applyRecovery: async (knowledge, input, actor) => {
      const workflow = needed(
        service<WorkflowService>(server, "workflowService"),
        "Procedure service",
      );
      const id = `recovery_${knowledge.id}_${knowledge.version}`;
      let procedure;
      try {
        procedure = workflow.getProcedure(id, undefined, actor);
      } catch (error: any) {
        if (error.statusCode !== 404) throw error;
      }
      if (!procedure)
        procedure = await workflow.saveProcedure(
          {
            id,
            name: knowledge.title,
            description: knowledge.note,
            steps: knowledge.steps.map((step, index) => ({
              id: `step_${index + 1}`,
              kind: "commands",
              input: recoveryCommands(step, knowledge.origin),
            })),
            recovery: [],
          },
          actor,
        );
      return workflow.startProcedure(
        procedure.id,
        {
          version: procedure.version,
          inputs: {},
          sessionId: input.sessionId,
          idempotencyKey: input.acceptanceId,
        },
        actor,
        { controlToken: input.controlToken },
      );
    },
  };
}
