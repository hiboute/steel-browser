import type { Actor } from "../control/access.js";
import type { Session, StartSessionOptions } from "../session.service.js";
import type { EngineResponse } from "../commands/engine.js";
export class RunPauseError extends Error {
  constructor(public reason: string) {
    super(reason);
  }
}
export interface RunStep {
  id: string;
  kind: string;
  input: unknown;
  retry?: { maxAttempts: number; delayMs: number };
}
export interface RunResult {
  stepId: string;
  status: "pending" | "running" | "succeeded" | "failed" | "uncertain" | "paused";
  attempts: number;
  startedAt?: string;
  finishedAt?: string;
  output?: unknown;
  error?: string;
}
export interface Run {
  id: string;
  sessionId?: string;
  ownerId: string;
  status: "queued" | "running" | "paused" | "uncertain" | "completed" | "failed" | "cancelled";
  revision: number;
  cursor: number;
  steps: RunStep[];
  results: RunResult[];
  createdAt: string;
  updatedAt: string;
  pauseReason?: string;
  metadata?: Record<string, unknown>;
  sessionOptions?: Partial<StartSessionOptions>;
  actor: Actor;
  idempotencyKey?: string;
  creationHash?: string;
}
export interface RunInput {
  controlToken?: string;
  sessionId?: string;
  sessionOptions?: Partial<StartSessionOptions>;
  steps: RunStep[];
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}
export interface RunContext {
  run: Run;
  step: RunStep;
  session: Session;
  actor: Actor;
  signal: AbortSignal;
  controlToken: string;
  execute(body: unknown, key?: string): Promise<EngineResponse>;
}
export interface RunKind {
  validate(input: unknown): unknown;
  replay: "safe" | "ambiguous";
  execute(
    ctx: RunContext,
  ): Promise<{ status: "succeeded" | "paused"; output?: unknown; reason?: string }>;
}
