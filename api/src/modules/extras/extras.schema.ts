import { z } from "zod";
import { buildJsonSchemas } from "../../utils/schema.js";

export const ExtensionName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
export const HttpUrl = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), "Use an HTTP or HTTPS URL");
export const WaitFor = z.union([z.number().int().min(0).max(30000), z.string().min(1).max(500)]);
const SessionIdentity = {
  cookieSets: z.array(z.string()).max(20).optional(),
  egress: z.string().max(128).optional(),
};
export const ExtractRequest = z
  .object({
    url: HttpUrl.optional(),
    sessionId: z.string().uuid().optional(),
    schema: z.record(z.string(), z.unknown()),
    prompt: z.string().max(10000).optional(),
    ...SessionIdentity,
    waitFor: WaitFor.optional(),
    queueTimeout: z.number().int().min(0).max(600000).optional(),
    includeMarkdown: z.boolean().optional(),
  })
  .strict();
export type ExtractInput = z.infer<typeof ExtractRequest>;
export const ExtractResponse = z.object({
  data: z.unknown(),
  url: z.string(),
  title: z.string(),
  model: z.string(),
  usage: z.record(z.string(), z.unknown()).optional(),
  markdown: z.string().optional(),
  extractionId: z.string().optional(),
  observedAt: z.string().optional(),
  evidence: z
    .array(
      z.object({
        path: z.string(),
        status: z.enum(["grounded", "uncertain", "missing"]),
        url: z.string(),
        observedAt: z.string(),
        excerpt: z.string().optional(),
        selector: z.string().optional(),
        reason: z.string().optional(),
      }),
    )
    .optional(),
});
export const WarmSettings = z
  .object({
    browserProfile: ExtensionName.optional(),
    ...SessionIdentity,
    startUrl: HttpUrl.optional(),
    extensions: z.array(ExtensionName).max(20).optional(),
    enabled: z.boolean().default(true),
    refreshMinutes: z.number().int().min(1).max(10080).optional(),
  })
  .strict();
export type WarmInput = z.infer<typeof WarmSettings>;
export const WarmDetails = WarmSettings.extend({
  name: ExtensionName,
  client: z.string().max(128).optional(),
  ownerId: z.string().max(128).optional(),
  ownerAuthenticated: z.boolean().optional(),
  sessionId: z.string().uuid(),
  status: z.enum(["disabled", "waiting", "starting", "live", "error"]),
  lastStartedAt: z.string().optional(),
  lastError: z.string().optional(),
});
export type WarmRecord = z.infer<typeof WarmDetails>;

export const WatcherSettings = z
  .object({
    name: z.string().min(1).max(80),
    url: HttpUrl,
    ...SessionIdentity,
    intervalMinutes: z.number().int().min(5).max(43200).default(60),
    activeHours: z
      .object({
        start: z.number().int().min(0).max(23),
        end: z.number().int().min(0).max(23),
        timezone: z.string().max(80).default("UTC"),
      })
      .optional(),
    waitFor: WaitFor.optional(),
    extract: z
      .object({
        selector: z.string().min(1).max(500).optional(),
        attribute: z.string().min(1).max(100).optional(),
        regex: z.string().max(500).optional(),
        fullText: z.boolean().optional(),
        llm: z
          .object({
            schema: z.record(z.string(), z.unknown()),
            prompt: z.string().max(10000).optional(),
          })
          .optional(),
      })
      .default({}),
    pageDiff: z
      .object({
        selector: z.string().max(500).optional(),
        ignoreSelectors: z.array(z.string().max(500)).max(30).optional(),
        ignorePatterns: z.array(z.string().min(1).max(200)).max(30).optional(),
        visual: z.boolean().optional(),
      })
      .strict()
      .optional(),
    condition: z
      .object({
        type: z.enum(["changed", "contains", "not_contains", "matches", "lt", "gt", "eq"]),
        value: z.union([z.string().max(500), z.number(), z.boolean()]).optional(),
      })
      .default({ type: "changed" }),
    notify: z
      .object({
        cooldownMinutes: z.number().min(0).max(43200).default(60),
        onErrorAfter: z.number().int().min(1).max(100).default(3),
      })
      .default({ cooldownMinutes: 60, onErrorAfter: 3 }),
    enabled: z.boolean().default(true),
  })
  .strict();
export type WatcherInput = z.infer<typeof WatcherSettings>;
// PATCH must not apply create defaults to fields the caller omitted.
export const WatcherPatch = z
  .object({
    name: WatcherSettings.shape.name.optional(),
    url: WatcherSettings.shape.url.optional(),
    cookieSets: WatcherSettings.shape.cookieSets,
    egress: WatcherSettings.shape.egress,
    intervalMinutes: WatcherSettings.shape.intervalMinutes.removeDefault().optional(),
    activeHours: WatcherSettings.shape.activeHours,
    waitFor: WatcherSettings.shape.waitFor,
    extract: WatcherSettings.shape.extract.removeDefault().partial().optional(),
    pageDiff: WatcherSettings.shape.pageDiff,
    condition: WatcherSettings.shape.condition.removeDefault().partial().optional(),
    notify: z
      .object({
        cooldownMinutes: z.number().min(0).max(43200).optional(),
        onErrorAfter: z.number().int().min(1).max(100).optional(),
      })
      .optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export const WatcherRun = z.object({
  at: z.string(),
  status: z.enum(["ok", "error", "postponed"]),
  value: z.unknown().optional(),
  matched: z.boolean().optional(),
  snapshotId: z.string().optional(),
  diff: z.unknown().optional(),
  error: z.string().optional(),
  code: z.string().optional(),
  statusCode: z.number().int().min(400).max(599).optional(),
  durationMs: z.number().optional(),
});
export type WatcherRunDetails = z.infer<typeof WatcherRun>;
export const WatcherDetails = WatcherSettings.extend({
  id: z.string().uuid(),
  client: z.string().max(128).optional(),
  ownerId: z.string().max(128).optional(),
  ownerAuthenticated: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  state: z.object({
    lastRunAt: z.string().optional(),
    nextRunAt: z.string(),
    lastValue: z.unknown().optional(),
    lastSnapshotId: z.string().optional(),
    consecutiveErrors: z.number().int(),
    lastNotifiedAt: z.string().optional(),
    lastErrorNotifiedAt: z.string().optional(),
    running: z.boolean().optional(),
  }),
});
export type WatcherRecord = z.infer<typeof WatcherDetails>;
export const ExtensionDetails = z.object({
  name: ExtensionName,
  title: z.string(),
  version: z.string(),
  description: z.string().optional(),
  manifestVersion: z.number(),
  installedAt: z.string().optional(),
  source: z.enum(["library", "bundled"]),
});
export const ExtrasError = z.object({
  success: z.literal(false),
  code: z.string(),
  message: z.string(),
});
export const { schemas: extrasSchemas, $ref: extrasRef } = buildJsonSchemas({
  ExtractRequest,
  ExtractResponse,
  WarmSettings,
  WarmDetails,
  WatcherSettings,
  WatcherDetails,
  WatcherRun,
  ExtensionDetails,
  ExtrasError,
});
