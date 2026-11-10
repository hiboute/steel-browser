import { z } from "zod";

export const extrasConfig = z
  .object({
    LLM_BASE_URL: z.string().url().optional(),
    LLM_API_KEY: z.string().optional(),
    LLM_MODEL: z.string().min(1).default("spark"),
    LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(45000),
    EXTRACT_MAX_CHARS: z.coerce.number().int().min(1000).max(1000000).default(100000),
    WATCHER_INTERVAL_MS: z.coerce.number().int().min(1000).max(300000).default(30000),
    EXTENSION_MAX_MB: z.coerce.number().int().min(1).max(100).default(25),
  })
  .parse(process.env);
