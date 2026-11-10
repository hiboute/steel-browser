import type { CreateSession, MultipleSessions, ReleaseSession, SessionDetails } from "./client";

export type { SessionDetails };

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), init);
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
  const { sessions } = await request<MultipleSessions>("/v1/sessions", { signal });
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
  },
): Promise<SessionDetails> {
  return request<SessionDetails>("/v1/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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
