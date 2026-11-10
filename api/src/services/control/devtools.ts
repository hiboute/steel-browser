import type { CDPService } from "../cdp/cdp.service.js";
import { AccessError } from "./access.js";

/** Resolve only targets belonging to this browser process, never a supplied upstream URL. */
export async function scopedCdpEndpoint(service: CDPService, pageId?: string): Promise<string> {
  const endpoint = service.getWsEndpoint();
  if (!endpoint) throw new AccessError("session_not_live", "Browser transport is unavailable", 409);
  if (!pageId) return endpoint;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(pageId))
    throw new AccessError("invalid_page", "Invalid browser target", 400);
  const pages = await service.getAllPages();
  if (!pages.some((page) => service.getTargetId(page) === pageId))
    throw new AccessError("page_not_found", "Page does not belong to this browser", 404);
  const scoped = new URL(endpoint);
  scoped.pathname = `/devtools/page/${pageId}`;
  scoped.search = "";
  return scoped.toString();
}
export function devtoolsAssetUrl(endpoint: string, asset: string): URL {
  if (
    !/^[A-Za-z0-9_@./-]+$/.test(asset) ||
    asset.split("/").some((part) => part === "." || part === ".." || !part)
  )
    throw new AccessError("invalid_asset", "Invalid DevTools asset", 400);
  const upstream = new URL(endpoint);
  upstream.protocol = "http:";
  upstream.pathname = `/devtools/${asset}`;
  upstream.search = "";
  upstream.hash = "";
  return upstream;
}
export async function readDevtoolsAsset(
  endpoint: string,
  asset: string,
): Promise<{ body: Buffer; type: string; status: number }> {
  const response = await fetch(devtoolsAssetUrl(endpoint, asset), {
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  const max = 20 * 1024 * 1024;
  if (Number(response.headers.get("content-length")) > max)
    throw new AccessError("asset_too_large", "DevTools asset exceeds size limit", 502);
  const chunks: Buffer[] = [];
  let bytes = 0;
  if (response.body)
    for await (const chunk of response.body as any) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > max)
        throw new AccessError("asset_too_large", "DevTools asset exceeds size limit", 502);
      chunks.push(buffer);
    }
  return {
    body: Buffer.concat(chunks),
    type: response.headers.get("content-type") ?? "application/octet-stream",
    status: response.status,
  };
}
