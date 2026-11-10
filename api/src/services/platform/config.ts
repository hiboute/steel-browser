import { z } from "zod";

/** Platform-only settings live together so plugins can be used independently. */
export const platformEnv = z
  .object({
    STEEL_DATA_DIR: z.string().default("data"),
    STEEL_DATA_KEY: z.string().optional(),
    COOKIE_LIBRARY_KEY: z.string().optional(),
    STEEL_VIEWER_URL: z.string().url().optional(),
    NOTIFY_WEBHOOK_URL: z.string().url().optional(),
    AUDIT_RETENTION_DAYS: z.coerce.number().int().min(1).default(180),
    FILES_RETENTION_HOURS: z.coerce.number().int().min(1).default(72),
    BACKGROUND_MAX_SESSIONS: z.coerce.number().int().min(0).default(1),
    MIN_FREE_MEMORY_MB: z.coerce.number().min(0).default(0),
    EGRESS_PROFILES: z.string().default("{}"),
    DEFAULT_EGRESS: z.string().default("direct"),
  })
  .parse(process.env);
