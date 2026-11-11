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

const duration = z.number().int().min(0).max(2_147_483_647);
const SessionSettings = z.object({
  name: z.string().max(80).optional(),
  labels: z
    .record(z.string().max(128), z.string().max(1024))
    .refine((value) => Object.keys(value).length <= 20, "At most 20 labels")
    .meta({ maxProperties: 20 })
    .optional(),
  timeout: duration
    .optional()
    .describe("Maximum live lifetime in milliseconds; zero disables the limit"),
  idleTimeout: duration
    .optional()
    .describe(
      "Release or park after this many milliseconds without activity; zero disables the limit",
    ),
  onExpire: z.enum(["park", "release"]).optional(),
  keepAlive: z.boolean().optional().describe("Exempt from idle expiry, but not maximum lifetime"),
});
export const CreateSession = SessionSettings.extend({
  identityProfile: z.string().max(128).optional(),
  compatibilityMode: z.enum(["native", "compatible", "legacy"]).optional(),
  siteProfile: z.string().max(128).optional(),
  mobileProfile: z.string().max(128).optional(),
  continuityPolicy: z.enum(["warn", "require-confirmation"]).optional(),
  continuityToken: z.string().max(2048).optional(),
  frictionDetection: z.boolean().optional(),
  egressPolicy: z.enum(["standard", "strict"]).optional(),
  siteScope: z.string().url().optional(),
  egress: z.string().max(128).optional(),
  record: z.boolean().optional(),
  cookieSetWriteBack: z.boolean().optional(),
  fingerprint: z.any().optional(),
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
    .describe(
      "Refuse requests to known ad, analytics and tracker hosts, for this session only. The document the session navigates to always loads.",
    ),
  saveData: z
    .boolean()
    .optional()
    .describe(
      "Skip images, media and fonts, for this session only. Shorthand for optimizeBandwidth with blockImages, blockMedia and blockFonts.",
    ),
  autoConsent: z
    .union([z.boolean(), z.enum(["reject", "accept"])])
    .optional()
    .describe(
      'Dismiss cookie consent banners of known consent managers. "reject" (or true) clicks the reject button and leaves a banner that only offers accept; "accept" still prefers reject and accepts when rejecting is not offered.',
    ),
  optimizeBandwidth: z
    .union([
      z.boolean(),
      z
        .object({
          blockImages: z.boolean().optional(),
          blockMedia: z.boolean().optional(),
          blockFonts: z.boolean().optional(),
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
    .regex(/^(?!\.\.?$)[a-zA-Z0-9._-]{1,64}$/)
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

const PageFilters = z
  .object({
    blockAds: z.boolean(),
    saveData: z.boolean(),
    autoConsent: z.enum(["off", "reject", "accept"]),
    requestsBlocked: z.number().int().describe("Requests refused so far, all reasons together"),
    blocked: z.object({
      ads: z.number().int(),
      rules: z.number().int(),
      images: z.number().int(),
      media: z.number().int(),
      fonts: z.number().int(),
      stylesheets: z.number().int(),
    }),
    bannersDismissed: z
      .number()
      .int()
      .describe("Consent banners that went away after their button was clicked"),
    lastBanner: z
      .object({
        at: z.string().datetime(),
        manager: z.string(),
        action: z.enum(["reject", "accept"]),
        label: z.string(),
        url: z.string(),
      })
      .optional(),
  })
  .describe("What the session filters and dismisses, with its counters");

const SessionDetails = z.object({
  ownerId: z.string().optional(),
  id: z.string().uuid().describe("Unique identifier for the session"),
  createdAt: z.string().datetime().describe("Timestamp when the session started"),
  status: z
    .enum(["idle", "live", "parked", "released", "failed"])
    .describe("Status of the session"),
  name: z.string().optional(),
  labels: z.record(z.string(), z.string()).optional(),
  client: z.string().optional(),
  slot: z.number().int().optional(),
  lastActivityAt: z.string().datetime().optional(),
  idleTimeout: duration.optional(),
  onExpire: z.enum(["park", "release"]).optional(),
  keepAlive: z.boolean().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  parkedAt: z.string().datetime().optional(),
  parkReason: z.enum(["manual", "idle", "timeout", "preempted", "shutdown"]).optional(),
  resumeCount: z.number().int().optional(),
  releaseReason: z
    .enum(["api", "idle", "timeout", "disconnected", "parked_expired", "shutdown"])
    .optional(),
  cookieSets: z.array(z.string()).optional(),
  cookieSetWriteBack: z.boolean().optional(),
  egress: z.string().optional(),
  recording: z.boolean().optional(),
  handoff: z.any().nullable().optional(),
  pageFilters: PageFilters.optional(),
  tabs: z.array(z.object({ url: z.string(), title: z.string(), active: z.boolean() })).optional(),
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
  parked: z.number().int().optional(),
  memory: z.any().optional(),
  limits: z.record(z.string(), z.any()).optional(),
  background: z.object({ running: z.number(), max: z.number() }).optional(),
  queue: z.array(
    z.object({
      position: z.number().int(),
      sessionId: z.string(),
      waitingMs: z.number(),
      client: z.string().optional(),
      kind: z.string().optional(),
    }),
  ),
  slots: z.array(
    z.object({
      index: z.number().int(),
      cdpPort: z.number().int(),
      primary: z.boolean(),
      state: z.enum(["free", "starting", "live", "stopping"]),
      sessionId: z.string().nullable(),
      sessionName: z.string().optional(),
      pid: z.number().nullable().optional(),
      rssBytes: z.number().optional(),
      pages: z.number().optional(),
    }),
  ),
});

const PoolFullResponse = z.object({
  success: z.literal(false),
  code: z.enum(["pool_full", "low_memory"]),
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
  SessionSettings,
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
