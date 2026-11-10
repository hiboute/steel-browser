import { createHash } from "node:crypto";
import type { Session } from "../session.service.js";

export type NavigationFailure =
  | "proxy_connection_failed"
  | "proxy_tunnel_failed"
  | "proxy_authentication_required"
  | "name_resolution_failed"
  | "connection_refused"
  | "connection_timed_out";

/** A new Chromium launch has a new endpoint, including resumes of the same session. */
export function diagnosticBrowserEpoch(session: Session): string | undefined {
  const endpoint = session.cdpService.getBrowserInstance()?.wsEndpoint?.();
  return endpoint
    ? createHash("sha256").update(`${session.id}\0${endpoint}`).digest("hex")
    : undefined;
}

/** Never retain the exception text: it can contain URLs or proxy credentials. */
export function navigationFailure(error: unknown): NavigationFailure | undefined {
  const message = error instanceof Error ? error.message : "";
  const codes: Array<[string, NavigationFailure]> = [
    ["ERR_PROXY_CONNECTION_FAILED", "proxy_connection_failed"],
    ["ERR_TUNNEL_CONNECTION_FAILED", "proxy_tunnel_failed"],
    ["ERR_PROXY_AUTH_UNSUPPORTED", "proxy_authentication_required"],
    ["ERR_NAME_NOT_RESOLVED", "name_resolution_failed"],
    ["ERR_CONNECTION_REFUSED", "connection_refused"],
    ["ERR_CONNECTION_TIMED_OUT", "connection_timed_out"],
    ["ERR_TIMED_OUT", "connection_timed_out"],
  ];
  return codes.find(([code]) => new RegExp(`\\b${code}\\b`).test(message))?.[1];
}
