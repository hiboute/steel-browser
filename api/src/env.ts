import { z } from "zod";
import { config } from "dotenv";

config();

const envSchema = z.object({
  NODE_ENV: z
    .enum(["test", "development", "staging", "production", "preview"])
    .default("development"),
  HOST: z.string().optional().default("0.0.0.0"),
  DOMAIN: z.string().optional(),
  PORT: z.string().optional().default("3000"),
  USE_SSL: z
    .string()
    .optional()
    .transform((val) => val === "true" || val === "1")
    .prefault("false"),
  CDP_REDIRECT_PORT: z.string().optional().default("9222"),
  CDP_DOMAIN: z.string().optional(),
  PROXY_URL: z.string().optional(),
  DEFAULT_HEADERS: z
    .string()
    .optional()
    .transform((val) => (val ? JSON.parse(val) : {}))
    .pipe(z.record(z.string(), z.string()).optional().default({})),
  BLOCK_ADS_EXTRA_HOSTS: z.string().optional(),
  BLOCK_ADS_ALLOW_HOSTS: z.string().optional(),
  // Hosts a session with blockPrivateNetwork may still reach, comma separated.
  PRIVATE_NETWORK_ALLOW_HOSTS: z.string().optional(),
  KILL_TIMEOUT: z.string().optional().default("0"),
  CHROME_EXECUTABLE_PATH: z.string().optional(),
  CHROME_HEADLESS: z
    .string()
    .optional()
    .transform((val) => val === "true" || val === "1")
    .prefault("true"),
  DISPLAY: z.string().optional().default(":10"),
  ENABLE_CDP_LOGGING: z
    .string()
    .optional()
    .transform((val) => val === "true" || val === "1")
    .prefault("false"),
  LOG_CUSTOM_EMIT_EVENTS: z
    .string()
    .optional()
    .transform((val) => val === "true" || val === "1")
    .prefault("false"),
  ENABLE_VERBOSE_LOGGING: z
    .string()
    .optional()
    .transform((val) => val === "true" || val === "1")
    .prefault("false"),
  DEFAULT_TIMEZONE: z.string().optional(),
  TIMEZONE_SERVICE_URL: z.string().optional(),
  SKIP_FINGERPRINT_INJECTION: z
    .string()
    .optional()
    .transform((val) => val === "true" || val === "1")
    .prefault("false"),
  CHROME_ARGS: z
    .string()
    .optional()
    .transform((val) => (val ? val.split(" ").map((arg) => arg.trim()) : []))
    .prefault(""),
  FILTER_CHROME_ARGS: z
    .string()
    .optional()
    .transform((val) => (val ? val.split(" ").map((arg) => arg.trim()) : []))
    .prefault(""),
  DEBUG_CHROME_PROCESS: z
    .string()
    .optional()
    .transform((val) => val === "true" || val === "1")
    .prefault("false"),
  PROXY_INTERNAL_BYPASS: z.string().optional(),
  CHROME_USER_DATA_DIR: z.string().optional(),
  LOG_STORAGE_ENABLED: z
    .string()
    .optional()
    .transform((val) => val === "true" || val === "1")
    .prefault("false"),
  LOG_STORAGE_PATH: z.string().optional(),
  DISABLE_CHROME_SANDBOX: z
    .string()
    .optional()
    .transform((val) => val === "true" || val === "1")
    .prefault("false"),
  ENABLE_COMMANDS_API: z
    .string()
    .optional()
    .transform((val) => val === "true" || val === "1")
    .prefault("false"),
  MAX_SESSIONS: z.coerce.number().int().min(1).prefault(1),
  SESSION_QUEUE_MAX_MS: z.coerce.number().int().min(1).max(2_147_483_647).prefault(600_000),
  SESSION_QUEUE_TIMEOUT_MS: z.coerce.number().int().min(0).max(2_147_483_647).prefault(0),
  SESSION_TIMEOUT_MS: z.coerce.number().int().min(0).max(2_147_483_647).prefault(0),
  SESSION_IDLE_TIMEOUT_MS: z.coerce.number().int().min(0).max(2_147_483_647).prefault(0),
  SESSION_EXPIRE_ACTION: z.enum(["park", "release"]).default("park"),
  SESSION_REAPER_INTERVAL_MS: z.coerce.number().int().min(10).max(2_147_483_647).prefault(10_000),
  SESSION_PREEMPT_IDLE_MS: z.coerce.number().int().min(0).max(2_147_483_647).prefault(0),
  PARKED_TTL_MS: z.coerce.number().int().min(0).prefault(604_800_000),
  PARKED_MAX: z.coerce.number().int().min(1).prefault(20),
  SHUTDOWN_PARK_TIMEOUT_MS: z.coerce.number().int().min(1).max(2_147_483_647).prefault(20_000),
  STEEL_DATA_DIR: z.string().optional(),
  STEEL_DATA_KEY: z.string().optional(),
  IDLE_IGNORED_CDP_METHODS: z
    .string()
    .default(
      "Page.screencastFrameAck,Input.dispatchMouseEvent:mouseMoved,Target.getTargets,Browser.getVersion,Target.setDiscoverTargets,Page.startScreencast,Page.stopScreencast,Page.enable,Runtime.enable",
    ),
  RRWEB_RECORDING: z
    .string()
    .optional()
    .transform((value) => value === "true" || value === "1")
    .prefault("false"),
  CDP_PORT_BASE: z.coerce.number().prefault(9222),
  /** Ports the pool never gives a browser: 9223 is the bundled nginx CDP proxy. */
  CDP_RESERVED_PORTS: z
    .string()
    .optional()
    .transform((val) =>
      (val ?? "9223")
        .split(",")
        .map((p) => Number(p.trim()))
        .filter((p) => Number.isInteger(p) && p > 0),
    ),
  COOKIE_LIBRARY_DIR: z.string().optional(),
  COOKIE_LIBRARY_KEY: z.string().optional(),
  /** Saved browsers: one persistent Chrome profile directory per name. */
  BROWSER_PROFILES_DIR: z.string().optional(),
  /** NordVPN service credentials, for sessions started with `vpn`. */
  NORDVPN_SERVICE_USER: z.string().optional(),
  NORDVPN_SERVICE_PASS: z.string().optional(),
});

export const env = envSchema.parse(process.env);
