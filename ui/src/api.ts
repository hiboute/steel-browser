import type { CreateSession, ReleaseSession, SessionDetails as GeneratedSession } from "./client";
import { controlHeaders } from "./control";

export type SessionDetails = Omit<GeneratedSession, "status"> & {
  status: "idle" | "live" | "released" | "failed" | "parked";
  name?: string;
  labels?: Record<string, string>;
  client?: string;
  slot?: number;
  idleTimeout?: number;
  onExpire?: "park" | "release";
  keepAlive?: boolean;
  lastActivityAt?: string;
  expiresAt?: string | null;
  parkedAt?: string | null;
  parkReason?: string | null;
  releaseReason?: string | null;
  resumeCount?: number;
  egress?: string;
  cookieSets?: string[];
  recording?: boolean;
  tabs?: { url: string; title: string; active?: boolean }[];
};

const apiBase = import.meta.env.VITE_API_URL ?? "/api";
const wsBase = import.meta.env.VITE_WS_URL ?? "/ws";

export function apiUrl(path: string): string {
  return new URL(`${apiBase}${path}`, window.location.href).toString();
}

export function wsUrl(path: string): string {
  const url = new URL(`${wsBase}${path}`, window.location.href);
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  return url.toString();
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: {
      "X-Steel-Client": "ui",
      ...controlHeaders(path.match(/^\/v1\/sessions\/([^/?]+)/)?.[1]),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
    throw new Error(
      typeof body?.message === "string"
        ? body.message
        : `Request to ${path} failed with ${response.status}`,
    );
  }
  return (await response.json()) as T;
}

/** Live sessions first (newest first), then the idle browser or released ones. */
export async function getSessions(signal: AbortSignal): Promise<SessionDetails[]> {
  const { sessions } = await request<{ sessions: SessionDetails[] }>(
    "/v1/sessions?include=parked",
    { signal },
  );
  return sessions;
}

/** Socket path for one session's stream (logs, pageId), or the unscoped one when idle. */
export function sessionSocketPath(session: SessionDetails | null | undefined, kind: string) {
  return session && session.status === "live"
    ? `/v1/sessions/${encodeURIComponent(session.id)}/${kind}`
    : `/v1/sessions/${kind}`;
}

/** Only the primary browser (root CDP socket) is reachable by the DevTools proxy. */
export function isPrimarySession(session: SessionDetails) {
  return !/\/v1\/sessions\/[^/]+\/cdp/.test(session.websocketUrl ?? "");
}

export function createSession(
  body: CreateSession & {
    cookieSets?: string[];
    browserProfile?: string;
    vpn?: { provider: "nordvpn"; country?: string };
    name?: string;
    labels?: Record<string, string>;
    timeout?: number;
    idleTimeout?: number;
    onExpire?: "park" | "release";
    keepAlive?: boolean;
    egress?: string;
    record?: boolean;
    queueTimeout?: number;
    extensions?: string[];
    identityProfile?: string;
    siteProfile?: string;
    mobileProfile?: string;
    compatibilityMode?: "native" | "compatible" | "legacy";
    continuityPolicy?: "warn" | "require-confirmation";
    continuityToken?: string;
    egressPolicy?: "standard" | "strict";
    siteScope?: string;
  },
  signal?: AbortSignal,
): Promise<SessionDetails> {
  return request<SessionDetails>("/v1/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

export function releaseSession(id: string): Promise<ReleaseSession> {
  return request<ReleaseSession>(`/v1/sessions/${encodeURIComponent(id)}/release`, {
    method: "POST",
  });
}

export type CookieSetSummary = {
  name: string;
  description?: string;
  domains: string[];
  cookieCount: number;
  originCount: number;
  expiresAt: string | null;
  sourceSessionId?: string;
  createdAt: string;
  updatedAt: string;
  authExpiresAt?: string | null;
  authCookies?: string[];
  health?: {
    status: "ok" | "expiring" | "expired" | "failing" | "unknown";
    lastCheckAt?: string;
    lastOkAt?: string;
    lastResult?: { ok: boolean; reason: string; finalUrl: string; durationMs: number };
    consecutiveFailures: number;
  };
  check?: {
    url: string;
    loggedInSelector?: string;
    loggedOutSelector?: string;
    loggedOutUrlPattern?: string;
    textIncludes?: string;
    intervalHours?: number;
    enabled?: boolean;
  };
  writeBack?: boolean;
  pinFingerprint?: boolean;
  egress?: string;
  acl?: { clients: string[] };
  hasFingerprint?: boolean;
  hasPrevious?: boolean;
  lastUsedAt?: string;
  useCount?: number;
};

export type BrowserProfileSummary = {
  name: string;
  inUseBy: string | null;
  updatedAt: string | null;
  fingerprint: boolean;
};

export async function listVpnProviders(signal?: AbortSignal) {
  return request<{ providers: { id: string; configured: boolean }[] }>("/v1/vpn", { signal });
}

export async function listBrowserProfiles(signal?: AbortSignal) {
  return request<{ profiles: BrowserProfileSummary[] }>("/v1/browser-profiles", { signal });
}

export async function listCookieSets(signal?: AbortSignal) {
  return request<{ sets: CookieSetSummary[]; encrypted: boolean }>("/v1/cookie-library", {
    signal,
  });
}

export function captureCookieSet(
  name: string,
  body: { sessionId: string; domains?: string[]; description?: string },
) {
  return request<CookieSetSummary>(`/v1/cookie-library/${encodeURIComponent(name)}/capture`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function deleteCookieSet(name: string) {
  return request<{ success: boolean }>(`/v1/cookie-library/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
}

export function mutate<T>(
  path: string,
  body?: unknown,
  method = "POST",
  signal?: AbortSignal,
  headers?: Record<string, string>,
) {
  return request<T>(path, {
    method,
    ...(body !== undefined
      ? { headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }
      : {}),
    ...(body === undefined ? { headers } : {}),
    signal,
  });
}
export const sessionPath = (id: string) => `/v1/sessions/${encodeURIComponent(id)}`;
export const parkSession = (id: string) => mutate<SessionDetails>(`${sessionPath(id)}/park`, {});
export const resumeSession = (id: string, signal?: AbortSignal) =>
  mutate<SessionDetails>(`${sessionPath(id)}/resume`, { queueTimeout: 45000 }, "POST", signal);
export const updateSession = (id: string, body: unknown) =>
  mutate<SessionDetails>(sessionPath(id), body, "PATCH");
export type PoolStatus = {
  maxSessions: number;
  live: number;
  free: number;
  parked?: number;
  queued: number;
  queue: {
    position: number;
    sessionId?: string;
    client?: string;
    waitingMs: number;
    kind?: string;
  }[];
  slots: {
    index: number;
    cdpPort: number;
    primary: boolean;
    state: string;
    sessionId: string | null;
    sessionName?: string;
    pid?: number;
    rssBytes?: number;
    pages?: number;
  }[];
  memory?: {
    totalBytes: number;
    availableBytes: number;
    limitBytes: number;
    chromeRssBytes: number;
    minFreeBytes: number;
    pressure: boolean;
  };
  background?: { running: number; max: number };
  limits?: Record<string, unknown>;
};
export type Handoff = {
  id: string;
  sessionId: string;
  status: "waiting" | "done" | "declined" | "cancelled" | "expired";
  reason: string;
  instructions?: string;
  requestedAt: string;
  resolvedAt?: string | null;
  expiresAt: string;
  liveUrl: string;
  note?: string;
};
export type TimelineEntry = {
  seq: number;
  at: string;
  client: string;
  kind: string;
  tool?: string;
  args?: unknown;
  status?: string;
  error?: string;
  durationMs?: number;
  url?: string;
  title?: string;
  screenshot: boolean;
};
export type Recording = {
  sessionId: string;
  status: "recording" | "stopped";
  startedAt: string;
  stoppedAt: string | null;
  frames: number;
  bytes: number;
  stopReason: string | null;
};
export type RecordingFrame = {
  seq: number;
  t: number;
  at: string;
  pageId: string;
  url: string;
  bytes: number;
};
export type EgressProfile = {
  name: string;
  label: string;
  type?: string;
  healthy?: boolean | null;
  publicIp?: string;
  country?: string;
  checkedAt?: string;
};
