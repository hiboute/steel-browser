export type Engine = "chromium" | "firefox" | "webkit" | "safari" | "android";
export type FleetCommandName = "launch" | "goto" | "click" | "fill" | "press" | "snapshot" | "screenshot" | "evaluate" | "cookies" | "checkpoint" | "close";
export interface WorkerCapabilities {
  protocol: 1;
  engines: Engine[];
  commands: FleetCommandName[];
  capacity: number;
  device: { kind: "desktop" | "android"; os: string; graphics: "native" | "software" | "unknown"; headless: boolean };
  strictEgress: boolean;
  browserVersions: Partial<Record<Engine, string>>;
}
export interface WorkerRecord {
  id: string;
  label: string;
  location: string;
  profileScope: string;
  tokenHash: string;
  generation: number;
  revoked: boolean;
  draining: boolean;
  lastSeen: number;
  capabilities: WorkerCapabilities;
}
export interface FleetSession {
  id: string;
  ownerId: string;
  workerId: string;
  engine: Engine;
  state: "launching" | "live" | "closing" | "closed" | "uncertain";
  createdAt: string;
  profileScope: string;
  egressPolicy: "standard" | "strict";
  lastError?: string;
  sourceCheckpointId?: string;
}
export interface FleetCommand {
  id: string;
  sessionId: string;
  workerId: string;
  generation: number;
  kind: FleetCommandName;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  state: "queued" | "running" | "completed" | "failed" | "uncertain";
  createdAt: string;
  claimedAt?: number;
  result?: unknown;
  error?: string;
}
export interface PortableCheckpoint {
  id: string;
  sessionId: string;
  ownerId: string;
  engine: Engine;
  createdAt: string;
  /** Portable web state; never claims to undo server mutations or preserve native browser internals. */
  state: { storageState: unknown; tabs: Array<{ url: string; sessionStorage?: Record<string, string> }> };
}
export class FleetError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 409) { super(message); }
}
