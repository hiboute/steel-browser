import { z } from "zod";
import { CDPCookieSchema } from "../../services/context/types.js";

const StoredLocalStorage = z.record(z.string(), z.record(z.string(), z.string()));
const CookieCheck = z.object({
  url: z
    .string()
    .url()
    .regex(/^https?:\/\//)
    .max(4096),
  loggedInSelector: z.string().max(1024).optional(),
  loggedOutSelector: z.string().max(1024).optional(),
  loggedOutUrlPattern: z.string().max(512).optional(),
  textIncludes: z.string().max(2048).optional(),
  intervalHours: z
    .number()
    .min(1 / 6)
    .max(8760)
    .optional(),
  enabled: z.boolean().optional(),
});
const CookieCheckResult = z.object({
  ok: z.boolean(),
  reason: z.string(),
  finalUrl: z.string(),
  durationMs: z.number(),
});
const CookieHealth = z.object({
  lastCheckAt: z.string().optional(),
  lastOkAt: z.string().optional(),
  lastResult: CookieCheckResult.optional(),
  consecutiveFailures: z.number().int(),
  warnedExpiry: z.string().optional(),
});
export const CookieSetSettings = z.object({
  description: z.string().max(4096).optional(),
  check: CookieCheck.optional(),
  authCookies: z.array(z.string().max(1024)).max(100).optional(),
  writeBack: z.boolean().optional(),
  pinFingerprint: z.boolean().optional(),
  egress: z.string().max(128).optional(),
  acl: z.object({ clients: z.array(z.string().max(128)).max(100) }).optional(),
});
const CookieSetSummary = CookieSetSettings.extend({
  name: z.string(),
  domains: z.array(z.string()),
  sourceSessionId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  cookieCount: z.number().int(),
  originCount: z.number().int(),
  expiresAt: z.string().nullable(),
  authExpiresAt: z.string().nullable(),
  health: CookieHealth.extend({
    status: z.enum(["ok", "expiring", "expired", "failing", "unknown"]),
  }),
  hasFingerprint: z.boolean(),
  hasPrevious: z.boolean(),
  lastUsedAt: z.string().optional(),
  useCount: z.number().int(),
});
const CookieFingerprint = z.object({
  fingerprint: z.any().optional(),
  userAgent: z.string().optional(),
  dimensions: z.object({ width: z.number(), height: z.number() }).optional(),
  timezone: z.string().optional(),
  locale: z.string().optional(),
});
const CookieSet = CookieSetSettings.extend({
  name: z.string(),
  cookies: z.array(CDPCookieSchema),
  localStorage: StoredLocalStorage.optional(),
  domains: z.array(z.string()),
  sourceSessionId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  health: CookieHealth.optional(),
  previous: z
    .object({
      cookies: z.array(CDPCookieSchema),
      localStorage: StoredLocalStorage.optional(),
      updatedAt: z.string(),
    })
    .optional(),
  fingerprint: CookieFingerprint.optional(),
  lastUsedAt: z.string().optional(),
  useCount: z.number().int().optional(),
});
export const cookieLibrarySchemas = {
  CookieSetSettings,
  CookieSetSummary,
  CookieSet,
  CookieSetName: z.object({ name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/) }),
  CookieSetImport: z.object({
    description: z.string().max(4096).optional(),
    cookies: z.array(CDPCookieSchema),
    localStorage: StoredLocalStorage.optional(),
  }),
  CookieSetCapture: z.object({
    sessionId: z.string().uuid().optional(),
    domains: z.array(z.string()).optional(),
    description: z.string().max(4096).optional(),
  }),
  CookieSetList: z.object({ sets: z.array(CookieSetSummary), encrypted: z.boolean() }),
  CookieSetChecked: z.object({ set: CookieSetSummary, result: CookieCheckResult }),
  CookieSetError: z.object({ success: z.literal(false), code: z.string(), message: z.string() }),
};
