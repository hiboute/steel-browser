import type { Handoff } from "../handoff.service.js";
import type { TimelineEntry } from "../timeline.service.js";

export interface WorkbenchActor {
  id: string;
  role: "operator" | "agent";
  authenticated: boolean;
}
export type InboxAction = "answer" | "retry" | "approve" | "reject" | "open";
export interface WorkSource {
  kind: "run" | "handoff" | "review" | "receipt";
  id: string;
  sessionId?: string;
  runId?: string;
  ownerId: string;
  status: string;
  title: string;
  description?: string;
  updatedAt: string;
  revision: string | number;
  actions: InboxAction[];
  details?: unknown;
}
export interface InboxCard extends Omit<WorkSource, "id" | "revision"> {
  id: string;
  sourceId: string;
  revision: string;
  sourceRevision: string;
  readAt: string | null;
  dismissedAt: string | null;
}
export interface SourceAction {
  action: Exclude<InboxAction, "open">;
  note?: string;
  resolution?: string;
  contentHash?: string;
  controlToken?: string;
}
export interface StateTelemetry {
  session: {
    id: string;
    name?: string;
    status: string;
    createdAt?: string;
    lastActivityAt?: string;
    expiresAt?: string | null;
    parkReason?: string | null;
    releaseReason?: string | null;
    onExpire?: string;
  };
  handoff?: Handoff;
  ownership?: { ownerId: string; mode: string; expiresAt: string } | null;
  runs?: WorkSource[];
  reviews?: WorkSource[];
  auth?: { name: string; status: string }[];
  queue?: { position: number; waitingMs?: number };
  lastAction?: TimelineEntry;
  unavailable: string[];
}
export interface StateReason {
  code: string;
  title: string;
  detail: string;
  since?: string;
  next: string;
  severity: "info" | "attention" | "error";
  sourceId?: string;
}
export interface StateExplanation {
  sessionId: string;
  observedAt: string;
  status: string;
  primary: StateReason;
  reasons: StateReason[];
  lastAction: { at: string; tool: string; title?: string; status?: string } | null;
  unavailable: string[];
}
export interface RecoveryStep {
  seq: number;
  tool: string;
  args?: unknown;
  title?: string;
  replayable: boolean;
}
export interface RecoveryKnowledge {
  id: string;
  version: number;
  ownerId: string;
  visibility: "private" | "workspace";
  origin: string;
  procedureId?: string;
  title: string;
  note: string;
  source: { sessionId: string; handoffId: string; resolvedAt: string };
  steps: RecoveryStep[];
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  disabled: boolean;
}
export interface KnowledgeInput {
  sessionId: string;
  handoffId: string;
  title: string;
  note: string;
  selectedSteps: number[];
  origin: string;
  procedureId?: string;
  visibility?: "private" | "workspace";
  expiresInDays?: number;
}
export interface WorkbenchAdapters {
  unavailable?(): string[];
  sources(actor: WorkbenchActor): Promise<WorkSource[]>;
  perform(source: WorkSource, input: SourceAction, actor: WorkbenchActor): Promise<unknown>;
  telemetry(sessionId: string, actor: WorkbenchActor): Promise<StateTelemetry>;
  authorize(
    sessionId: string,
    actor: WorkbenchActor,
    controlToken?: string,
    write?: boolean,
  ): Promise<void>;
  handoff(sessionId: string): Handoff | undefined;
  timeline(sessionId: string): Promise<TimelineEntry[]>;
  sessionOrigin(sessionId: string): Promise<string | null>;
  applyRecovery?(
    knowledge: RecoveryKnowledge,
    input: { sessionId: string; controlToken?: string; acceptanceId: string },
    actor: WorkbenchActor,
  ): Promise<unknown>;
}
