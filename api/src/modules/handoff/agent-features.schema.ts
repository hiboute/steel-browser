import { z } from "zod";
import { buildJsonSchemas } from "../../utils/schema.js";

const HandoffStatus = z.enum(["waiting", "done", "declined", "cancelled", "expired"]);
const DoneWhen = z.object({
  urlMatches: z.string().max(500).optional(),
  urlNotMatches: z.string().max(500).optional(),
  selector: z.string().max(1000).optional(),
  selectorGone: z.string().max(1000).optional(),
});
const CreateHandoff = z.object({
  reason: z.string().min(1).max(1000),
  instructions: z.string().max(10000).optional(),
  doneWhen: DoneWhen.optional(),
  timeoutMs: z.number().int().min(1).max(3600000).optional(),
  notify: z.boolean().optional(),
});
const HandoffRecord = CreateHandoff.omit({ timeoutMs: true, notify: true }).extend({
  id: z.string().uuid(),
  sessionId: z.string(),
  status: HandoffStatus,
  requestedBy: z.string(),
  requestedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable(),
  resolvedBy: z.string().nullable(),
  note: z.string().nullable(),
  liveUrl: z.string(),
});
const ResolveHandoff = z.object({
  note: z.string().max(10000).optional(),
  declined: z.boolean().optional(),
});
const HandoffQuery = z.object({ wait: z.number().min(0).max(50).optional() });
const HandoffsQuery = z.object({ status: HandoffStatus.optional() });
const HandoffsResponse = z.object({ handoffs: z.array(HandoffRecord) });
const PostTimeline = z.object({
  kind: z.string().min(1).max(64).optional(),
  tool: z.string().min(1).max(128),
  args: z.unknown().optional(),
  status: z.string().max(64).optional(),
  error: z.string().max(10000).optional(),
  durationMs: z.number().min(0).optional(),
  url: z.string().max(10000).optional(),
  title: z.string().max(1000).optional(),
  screenshot: z.boolean().optional(),
});
const TimelineEntry = PostTimeline.extend({
  seq: z.number().int(),
  at: z.string().datetime(),
  client: z.string(),
  kind: z.string(),
  screenshot: z.boolean(),
});
const TimelineQuery = z.object({
  after: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(2000).optional(),
});
const TimelineResponse = z.object({ entries: z.array(TimelineEntry) });
const AgentSessionParams = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/) });
const AgentFrameParams = AgentSessionParams.extend({ seq: z.number().int().min(1) });
const RecordingDetails = z.object({
  sessionId: z.string(),
  status: z.enum(["recording", "stopped"]),
  startedAt: z.string().datetime(),
  stoppedAt: z.string().datetime().nullable(),
  frames: z.number().int(),
  bytes: z.number().int(),
  stopReason: z.string().nullable(),
});
const RecordingFrame = z.object({
  seq: z.number().int(),
  t: z.number(),
  at: z.string().datetime(),
  pageId: z.string(),
  url: z.string(),
  bytes: z.number().int(),
});
const RecordingFramesQuery = z.object({
  from: z.number().min(0).optional(),
  to: z.number().min(0).optional(),
  limit: z.number().int().min(1).max(5000).optional(),
});
const RecordingFramesResponse = z.object({ frames: z.array(RecordingFrame) });
const RecordingsResponse = z.object({ recordings: z.array(RecordingDetails) });
const AgentFeatureError = z.object({
  success: z.literal(false),
  code: z.string(),
  message: z.string(),
});
const AgentFeatureSuccess = z.object({ success: z.literal(true) });

export const { schemas, $ref } = buildJsonSchemas({
  CreateHandoff,
  HandoffRecord,
  ResolveHandoff,
  HandoffQuery,
  HandoffsQuery,
  HandoffsResponse,
  PostTimeline,
  TimelineEntry,
  TimelineQuery,
  TimelineResponse,
  AgentSessionParams,
  AgentFrameParams,
  RecordingDetails,
  RecordingFrame,
  RecordingFramesQuery,
  RecordingFramesResponse,
  RecordingsResponse,
  AgentFeatureError,
  AgentFeatureSuccess,
});
