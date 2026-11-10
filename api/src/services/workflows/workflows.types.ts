import { z } from "zod";

const json = z.record(z.string(), z.unknown());
export const ProductId = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,128}$/)
  .refine(
    (value) => !["__proto__", "constructor", "prototype"].includes(value),
    "Reserved identifier",
  );
export const AssertionSchema = z
  .object({
    id: ProductId,
    label: z.string().min(1).max(200),
    command: json,
    path: z.string().max(200).default("results.0.value"),
    operator: z.enum(["equals", "contains", "exists", "not_exists"]),
    expected: z.unknown().optional(),
    evidence: z.enum(["value", "screenshot"]).default("value"),
  })
  .strict();
export type Assertion = z.infer<typeof AssertionSchema>;

export const ProposalSchema = z
  .object({
    summary: z.string().min(1).max(2000),
    destination: z.string().min(1).max(2000),
    fields: json.default({}),
    attachments: z
      .array(
        z
          .object({
            name: z.string().min(1).max(255),
            artifactId: ProductId,
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(50)
      .default([]),
  })
  .strict();
export type Proposal = z.infer<typeof ProposalSchema>;
const InputReference = z.object({ $input: z.string().min(1).max(200) }).strict();
const ProposalTemplateSchema = ProposalSchema.extend({
  summary: z.union([z.string().min(1).max(2000), InputReference]),
  destination: z.union([z.string().min(1).max(2000), InputReference]),
});

export const ProcedureStepSchema = z.discriminatedUnion("kind", [
  z
    .object({
      id: ProductId,
      kind: z.literal("commands"),
      input: json,
      review: ProposalTemplateSchema.optional(),
      retry: z
        .object({
          maxAttempts: z.number().int().min(1).max(5),
          delayMs: z.number().int().min(0).max(60000),
        })
        .optional(),
    })
    .strict(),
  z.object({ id: ProductId, kind: z.literal("assert"), assertion: AssertionSchema }).strict(),
  z
    .object({
      id: ProductId,
      kind: z.literal("vault_fill"),
      reference: ProductId,
      selector: z.string().min(1).max(2000),
      frameUrl: z.string().url().optional(),
    })
    .strict(),
]);
export const ProcedureInputSchema = z
  .object({
    id: ProductId.optional(),
    name: z.string().min(1).max(200),
    description: z.string().max(5000).default(""),
    inputSchema: json.default({ type: "object", additionalProperties: false, properties: {} }),
    steps: z.array(ProcedureStepSchema).min(1).max(100),
    recovery: z
      .array(z.object({ reason: z.string().max(200), instructions: z.string().max(4000) }).strict())
      .max(20)
      .default([]),
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict();
export type ProcedureInput = z.infer<typeof ProcedureInputSchema>;
export interface ProcedureVersion extends Omit<ProcedureInput, "expectedVersion"> {
  id: string;
  version: number;
  ownerId: string;
  createdAt: string;
  digest: string;
}

export const ProcedureStartSchema = z
  .object({
    version: z.number().int().positive().optional(),
    inputs: json.default({}),
    sessionId: ProductId.optional(),
    sessionOptions: json.optional(),
    idempotencyKey: z.string().min(1).max(128),
  })
  .strict();
export type ProcedureStart = z.infer<typeof ProcedureStartSchema>;

export interface WorkflowActor {
  id: string;
  role: "operator" | "agent";
  authenticated: boolean;
}
export interface WorkflowStep {
  id: string;
  kind: string;
  input: unknown;
  retry?: { maxAttempts: number; delayMs: number };
}
export interface WorkflowRun {
  id: string;
  sessionId?: string;
  ownerId: string;
  status: string;
  revision: number;
  cursor: number;
  steps: WorkflowStep[];
  results: Array<{ stepId: string; status: string; output?: unknown; error?: unknown }>;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  pauseReason?: string;
}
export interface StepContext {
  run: WorkflowRun;
  step: WorkflowStep;
  session: unknown;
  actor: WorkflowActor;
  signal: AbortSignal;
  controlToken?: string;
  execute(body: unknown, key?: string): Promise<{ status: number; body: Record<string, unknown> }>;
}
export interface WorkflowRuntime {
  create(
    input: {
      sessionId?: string;
      sessionOptions?: Record<string, unknown>;
      steps: WorkflowStep[];
      metadata: Record<string, unknown>;
      idempotencyKey: string;
      controlToken?: string;
    },
    actor: WorkflowActor,
  ): Promise<WorkflowRun>;
  get(id: string, actor: WorkflowActor): Promise<WorkflowRun> | WorkflowRun;
  list(actor: WorkflowActor): Promise<WorkflowRun[]> | WorkflowRun[];
  resume(id: string, actor: WorkflowActor): Promise<WorkflowRun>;
  cancel(id: string, actor: WorkflowActor): Promise<WorkflowRun>;
  registerKind(
    kind: string,
    handler: {
      validate(input: unknown): unknown;
      replay: "safe" | "ambiguous";
      execute(
        context: StepContext,
      ): Promise<{ status: "succeeded" | "paused"; output?: unknown; reason?: string }>;
    },
  ): void;
  beforeStep(handler: (context: StepContext) => Promise<void>): void;
  pauseError(reason: string): Error;
}

export interface ReviewRecord {
  id: string;
  runId: string;
  stepId: string;
  ownerId: string;
  proposal: Proposal;
  command: Record<string, unknown>;
  contentHash: string;
  preparedStateHash: string;
  preparedSnapshot: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  decidedAt?: string;
  decisionBy?: string;
}
export interface AssertionResult {
  id: string;
  label: string;
  status: "passed" | "failed" | "unavailable";
  operator: Assertion["operator"];
  expected?: unknown;
  actual?: unknown;
  observedAt: string;
  url?: string;
  source: "browser-command";
  evidence?: { type: "screenshot"; artifactId: string; sha256: string };
  reason?: string;
}
export interface CompletionReceipt {
  id: string;
  runId: string;
  sessionId?: string;
  ownerId: string;
  procedureId?: string;
  procedureVersion?: number;
  status: "verified" | "waiting" | "failed" | "uncertain";
  assertions: AssertionResult[];
  runStatus: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  summary: string;
}

export const ScheduleInputSchema = z
  .object({
    id: ProductId.optional(),
    name: z.string().min(1).max(200),
    procedureId: ProductId,
    version: z.number().int().positive(),
    inputs: json.default({}),
    sessionId: ProductId.optional(),
    sessionOptions: json.optional(),
    enabled: z.boolean().default(true),
    trigger: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("interval"),
          everySeconds: z.number().int().min(60).max(31536000),
        })
        .strict(),
      z
        .object({
          kind: z.literal("daily"),
          at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
          timezone: z.string().min(1).max(100),
        })
        .strict(),
      z.object({ kind: z.literal("webhook") }).strict(),
      z
        .object({
          kind: z.literal("watcher"),
          watcherId: ProductId,
          onlyMatched: z.boolean().default(true),
        })
        .strict(),
    ]),
    missedRun: z.enum(["skip", "run_once"]).default("skip"),
    maxLatenessSeconds: z.number().int().min(60).max(604800).default(3600),
    maxConcurrent: z.number().int().min(1).max(10).default(1),
    deadlineSeconds: z.number().int().min(60).max(86400).default(3600),
  })
  .strict();
export type ScheduleInput = z.infer<typeof ScheduleInputSchema>;
export interface ScheduleRecord extends ScheduleInput {
  id: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string;
  lastLocalDate?: string;
  webhookHash?: string;
}
export interface TriggerRecord {
  id: string;
  scheduleId: string;
  ownerId: string;
  key: string;
  state: "pending" | "started" | "skipped" | "failed";
  at: string;
  runId?: string;
  reason?: string;
  deadlineAt: string;
}

export const ReplayInputSchema = z
  .object({
    baselineRunId: ProductId,
    inputs: json.default({}),
    candidate: z
      .object({ label: z.string().min(1).max(200), sessionOptions: json.default({}) })
      .strict(),
    allowedOrigins: z.array(z.string().url()).min(1).max(10),
    allowMutations: z.boolean().default(false),
    idempotencyKey: z.string().min(1).max(128),
  })
  .strict();
export interface ReplayRecord {
  id: string;
  ownerId: string;
  baselineRunId: string;
  candidateRunId: string;
  candidateLabel: string;
  procedureId: string;
  procedureVersion: number;
  allowedOrigins: string[];
  createdAt: string;
  status: "running" | "passed" | "regressed" | "inconclusive";
  differences: Array<{
    assertionId: string;
    baseline: unknown;
    candidate: unknown;
    reason: string;
  }>;
  observedBrowserVersion?: string;
  runtimeRevision?: string;
}

export class WorkflowError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}
