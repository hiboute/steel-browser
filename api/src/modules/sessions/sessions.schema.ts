import { FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ScrapeRequestBody,
  ScreenshotRequestBody,
  PDFRequestBody,
} from "../actions/actions.schema.js";
import { SessionContextSchema } from "../../services/context/types.js";
import { env } from "../../env.js";

const deviceConfigSchema = z
  .object({
    device: z.enum(["desktop", "mobile"]).default("desktop"),
  })
  .optional()
  .describe("Device configuration for the session");

export type CredentialsOptions = z.infer<typeof SessionCredentials>;
export const SessionCredentials = z
  .object({
    autoSubmit: z.union([z.boolean(), z.never()]),
    blurFields: z.union([z.boolean(), z.never()]),
    exactOrigin: z.union([z.boolean(), z.never()]),
  })
  .partial()
  .optional()
  .describe("Configuration for session credentials");

const CreateSession = z.object({
  queueTimeout: z
    .number()
    .int()
    .min(0)
    .max(env.SESSION_QUEUE_MAX_MS ?? 600_000)
    .optional()
    .describe(
      "Maximum time in milliseconds to wait FIFO for a browser slot. Zero fails immediately when full.",
    ),
  sessionId: z.string().uuid().optional().describe("Unique identifier for the session"),
  proxyUrl: z.string().optional().describe("Proxy URL to use for the session"),
  userAgent: z.string().optional().describe("User agent string to use for the session"),
  sessionContext: SessionContextSchema.optional().describe(
    "Session context data to be used in the created session",
  ),
  cookieSets: z
    .array(z.string())
    .optional()
    .describe(
      "Names of cookie library sets to load into the session (cookies and localStorage), merged in order before sessionContext",
    ),
  isSelenium: z.boolean().optional().describe("Indicates if Selenium is used in the session"),
  blockAds: z
    .boolean()
    .optional()
    .describe("Flag to indicate if ads should be blocked in the session"),
  optimizeBandwidth: z
    .union([
      z.boolean(),
      z
        .object({
          blockImages: z.boolean().optional(),
          blockMedia: z.boolean().optional(),
          blockStylesheets: z.boolean().optional(),
          blockHosts: z.array(z.string()).optional(),
          blockUrlPatterns: z.array(z.string()).optional(),
        })
        .strict(),
    ])
    .optional()
    .describe(
      "Enable bandwidth optimizations. Passing true enables all flags (except hosts/patterns). Object allows granular control.",
    ),
  skipFingerprintInjection: z
    .boolean()
    .optional()
    .describe("Flag to indicate if fingerprint injection should be skipped for this session."),
  deviceConfig: deviceConfigSchema,
  fullscreen: z
    .boolean()
    .optional()
    .describe("Launch the browser in fullscreen mode, covering the full screen with no Chrome UI."),
  // Specific to hosted steel
  logSinkUrl: z.string().optional().describe("Deprecated: Log sink URL to use for the session"),
  extensions: z.array(z.string()).optional().describe("Extensions to use for the session"),
  persist: z.boolean().optional().describe("Flag to indicate if session should be persisted"),
  vpn: z
    .object({
      provider: z.literal("nordvpn"),
      country: z
        .string()
        .regex(/^[A-Za-z]{2}$/)
        .optional()
        .describe("Two-letter country code of the exit (default: NordVPN's recommended server)"),
    })
    .optional()
    .describe("Route the session through a VPN (instead of proxyUrl)."),
  browserProfile: z
    .string()
    .regex(/^[a-zA-Z0-9._-]{1,64}$/)
    .optional()
    .describe(
      "Saved browser: run the session in this named, persistent Chrome profile (created on first use). It keeps cookies, storage and its fingerprint across sessions, so sites see the same device. One live session per profile.",
    ),
  userDataDir: z.string().optional().describe("User data directory path to use for the session"),
  timezone: z.string().optional().describe("Timezone to use for the session"),
  dimensions: z
    .object({
      width: z.number(),
      height: z.number(),
    })
    .optional()
    .describe("Dimensions to use for the session"),
  userPreferences: z
    .record(z.string(), z.any())
    .optional()
    .describe(
      "Chrome user preferences to customize browser behavior (e.g., font size, popup blocking, notification settings)",
    ),
  extra: z
    .record(z.string(), z.any())
    .optional()
    .describe("Extra metadata to help initialize the session"),
  credentials: SessionCredentials,
  headless: z.boolean().optional().describe("Headless mode for the session"),
});

const SessionDetails = z.object({
  id: z.string().uuid().describe("Unique identifier for the session"),
  createdAt: z.string().datetime().describe("Timestamp when the session started"),
  status: z.enum(["idle", "live", "released", "failed"]).describe("Status of the session"),
  duration: z.number().int().describe("Duration of the session in milliseconds"),
  eventCount: z.number().int().describe("Number of events processed in the session"),
  dimensions: z
    .object({
      width: z.number(),
      height: z.number(),
    })
    .optional()
    .describe("Dimensions used for the session"),
  timeout: z.number().int().describe("Session timeout duration in milliseconds"),
  creditsUsed: z.number().int().describe("Amount of credits consumed by the session"),
  websocketUrl: z.string().describe("URL for the session's WebSocket connection"),
  debugUrl: z.string().describe("URL for a viewing the live browser instance for the session"),
  debuggerUrl: z.string().describe("URL for debugging the session"),
  sessionViewerUrl: z.string().describe("URL to view session details"),
  userAgent: z.string().optional().describe("User agent string used in the session"),
  proxy: z.string().optional().describe("Proxy server used for the session"),
  proxyTxBytes: z
    .number()
    .int()
    .nonnegative()
    .describe("Amount of data transmitted through the proxy"),
  proxyRxBytes: z
    .number()
    .int()
    .nonnegative()
    .describe("Amount of data received through the proxy"),
  solveCaptcha: z.boolean().optional().describe("Indicates if captcha solving is enabled"),
  isSelenium: z.boolean().optional().describe("Indicates if Selenium is used in the session"),
  deviceConfig: deviceConfigSchema,
  browserProfile: z.string().optional().describe("Saved browser profile the session runs in"),
});

const ReleaseSession = SessionDetails.merge(
  z.object({ success: z.boolean().describe("Indicates if the session was successfully released") }),
);

const ReleaseSessionsRequest = z
  .object({
    sessionId: z
      .string()
      .uuid()
      .optional()
      .describe("Release only this session; omit to release all live sessions"),
  })
  .nullable();

const PoolStatus = z.object({
  maxSessions: z.number().int(),
  live: z.number().int(),
  free: z.number().int(),
  queued: z.number().int(),
  queue: z.array(
    z.object({ position: z.number().int(), sessionId: z.string(), waitingMs: z.number() }),
  ),
  slots: z.array(
    z.object({
      index: z.number().int(),
      cdpPort: z.number().int(),
      primary: z.boolean(),
      state: z.enum(["free", "starting", "live", "stopping"]),
      sessionId: z.string().nullable(),
    }),
  ),
});

const PoolFullResponse = z.object({
  success: z.literal(false),
  code: z.literal("pool_full"),
  message: z.string(),
  pool: z.object({ max: z.number().int(), live: z.number().int(), queued: z.number().int() }),
});

const PoolClosedResponse = z.object({
  success: z.literal(false),
  code: z.literal("shutting_down"),
  message: z.string(),
});

const SessionNotFoundResponse = z.object({
  success: z.literal(false),
  code: z.literal("session_not_found"),
  message: z.string(),
});

const RecordedEvents = z.object({
  events: z.array(z.any()).describe("Events to emit"),
});

const SessionStreamQuery = z.object({
  showControls: z
    .boolean()
    .optional()
    .default(true)
    .describe("Show controls in the browser iframe"),
  theme: z
    .enum(["dark", "light"])
    .optional()
    .default("dark")
    .describe("Theme of the browser iframe"),
  interactive: z.boolean().optional().default(true).describe("Make the browser iframe interactive"),
  pageId: z.string().optional().describe("Page ID to connect to"),
  pageIndex: z.string().optional().describe("Page index (or tab index) to connect to"),
});

const SessionLiveDetailsResponse = z.object({
  sessionViewerUrl: z.string(),
  sessionViewerFullscreenUrl: z.string(),
  websocketUrl: z.string(),
  pages: z.array(
    z.object({
      id: z.string(),
      url: z.string(),
      title: z.string(),
      favicon: z.string().nullable(),
    }),
  ),
  browserState: z.object({
    status: z.enum(["idle", "live", "released", "failed"]),
    userAgent: z.string(),
    browserVersion: z.string(),
    initialDimensions: z.object({
      width: z.number(),
      height: z.number(),
    }),
    pageCount: z.number(),
  }),
});

const SessionStreamResponse = z.string().describe("HTML content for the session streamer view");

const MultipleSessions = z.object({
  sessions: z.array(SessionDetails),
});

export type SessionsScrapeRequestBody = Omit<ScrapeRequestBody, "url">;
export type SessionsScrapeRequest = FastifyRequest<{ Body: SessionsScrapeRequestBody }>;

export type SessionsScreenshotRequestBody = Omit<ScreenshotRequestBody, "url">;
export type SessionsScreenshotRequest = FastifyRequest<{ Body: SessionsScreenshotRequestBody }>;

export type SessionsPDFRequestBody = Omit<PDFRequestBody, "url">;
export type SessionsPDFRequest = FastifyRequest<{ Body: SessionsPDFRequestBody }>;

export type RecordedEvents = z.infer<typeof RecordedEvents>;
export type CreateSessionBody = z.infer<typeof CreateSession>;
export type CreateSessionRequest = FastifyRequest<{ Body: CreateSessionBody }>;
export type SessionDetails = z.infer<typeof SessionDetails>;
export type MultipleSessions = z.infer<typeof MultipleSessions>;

export type SessionStreamQuery = z.infer<typeof SessionStreamQuery>;
export type SessionStreamRequest = FastifyRequest<{ Querystring: SessionStreamQuery }>;

export const browserSchemas = {
  CreateSession,
  SessionDetails,
  MultipleSessions,
  SessionContextSchema,
  RecordedEvents,
  ReleaseSession,
  ReleaseSessionsRequest,
  PoolStatus,
  PoolFullResponse,
  PoolClosedResponse,
  SessionNotFoundResponse,
  SessionStreamQuery,
  SessionStreamResponse,
  SessionLiveDetailsResponse,
};

export default browserSchemas;
