import { env } from "../env.js";
import { createAdMatcher, type HostMatcher } from "./ad-hosts.js";

const RE_IMAGE_EXT = /\.(jpg|jpeg|png|webp|svg|ico)(\?.*)?$/i;
const RE_VIDEO_EXT = /\.(mp4|m4s|m3u8|ts|webm|gif)(\?.*)?$/i;
const RE_FONT_EXT = /\.(woff2?|ttf|otf|eot)$/i;
const RE_RANGE = /range=\d+-\d+/i;

export function tryParseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

// Hostnames are case-insensitive and may carry a trailing root dot ("example.com.").
function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}

function hostMatches(hostname: string, host: string): boolean {
  return hostname === host || hostname.endsWith(`.${host}`);
}

let adMatcher: HostMatcher | undefined;

/** The `blockAds` matcher: the built-in list plus BLOCK_ADS_EXTRA_HOSTS, minus BLOCK_ADS_ALLOW_HOSTS. */
export function defaultAdMatcher(): HostMatcher {
  adMatcher ??= createAdMatcher(env.BLOCK_ADS_EXTRA_HOSTS, env.BLOCK_ADS_ALLOW_HOSTS);
  return adMatcher;
}

export function isAdRequest(parsed: URL): boolean {
  return defaultAdMatcher()(parsed.hostname) !== undefined;
}

export function isFontRequest(parsed: URL): boolean {
  return RE_FONT_EXT.test(parsed.pathname);
}

export function isImageRequest(parsed: URL): boolean {
  return RE_IMAGE_EXT.test(parsed.pathname);
}

export function isHeavyMediaRequest(parsed: URL): boolean {
  const { pathname, searchParams } = parsed;
  if (RE_VIDEO_EXT.test(pathname)) return true;
  const isRange = searchParams.has("range") || RE_RANGE.test(parsed.href);
  return isRange && pathname.includes("/avf/");
}

export function normalizeHosts(hosts: string[]): string[] {
  return hosts.map(normalizeHost);
}

export function isHostBlocked(parsed: URL, normalizedHosts?: string[]): boolean {
  if (!normalizedHosts?.length) return false;
  const hostname = normalizeHost(parsed.hostname);
  return normalizedHosts.some((h) => hostMatches(hostname, h));
}

export function compileUrlPatterns(patterns: string[]): RegExp[] {
  return patterns.map((pattern) => {
    try {
      return new RegExp(
        `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
        "i",
      );
    } catch {
      // Fallback: escape the entire pattern for literal matching
      return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
  });
}

export function isUrlMatchingPatterns(url: string, compiledPatterns?: RegExp[]): boolean {
  if (!compiledPatterns?.length) return false;
  return compiledPatterns.some((re) => re.test(url));
}

export type BlockKind = "ads" | "rules" | "images" | "media" | "fonts" | "stylesheets";

export interface RequestFilter {
  /** Matcher of the `blockAds` list, or undefined when ads are not blocked. */
  ads?: HostMatcher;
  /** Operator rules of `optimizeBandwidth.blockHosts`, already normalized. */
  hosts?: string[];
  /** Operator rules of `optimizeBandwidth.blockUrlPatterns`, already compiled. */
  urlPatterns?: RegExp[];
  images?: boolean;
  media?: boolean;
  fonts?: boolean;
  stylesheets?: boolean;
}

export interface FilteredRequest {
  url: string;
  /** Puppeteer resource type: document, image, media, font, stylesheet, ... */
  resourceType: string;
  /** A navigation of the page's main frame: what the caller asked to open. */
  mainFrameNavigation?: boolean;
  /** URL of the page's main frame, for the first-party exemption of the ad list. */
  pageUrl?: string;
  /** The request's Referer header, for the same exemption while the page URL is not known yet. */
  referrer?: string;
}

/**
 * Says why a request is refused, or undefined when it goes through.
 *
 * Operator rules (hosts, URL patterns) apply to everything. The ad list and
 * the resource types apply to http(s) subresources only: the document the
 * caller navigates to always loads, and a site on the ad list still gets its
 * own resources when it is the page being visited.
 */
export function blockReason(
  request: FilteredRequest,
  filter: RequestFilter,
): BlockKind | undefined {
  const parsed = tryParseUrl(request.url);
  if (
    (parsed && isHostBlocked(parsed, filter.hosts)) ||
    isUrlMatchingPatterns(request.url, filter.urlPatterns)
  )
    return "rules";
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) return undefined;
  if (request.mainFrameNavigation) return undefined;

  if (filter.ads) {
    const entry = filter.ads(parsed.hostname);
    if (entry) {
      const firstParty = [request.pageUrl, request.referrer].some((value) => {
        const from = value ? tryParseUrl(value) : null;
        return !!from && filter.ads!(from.hostname) === entry;
      });
      if (!firstParty) return "ads";
    }
  }

  const type = request.resourceType;
  // An extension only decides for requests whose type does not already say what they are.
  const untyped = type === "other" || type === "fetch" || type === "xhr";
  if (filter.images && (type === "image" || (untyped && isImageRequest(parsed)))) return "images";
  if (filter.media && (type === "media" || (untyped && isHeavyMediaRequest(parsed))))
    return "media";
  if (filter.fonts && (type === "font" || (untyped && isFontRequest(parsed)))) return "fonts";
  if (filter.stylesheets && type === "stylesheet") return "stylesheets";
  return undefined;
}
