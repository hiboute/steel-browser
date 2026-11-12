import type { OptimizeBandwidthOptions } from "../types/browser.js";
import type { BlockKind } from "../utils/requests.js";

export type AutoConsentMode = "off" | "reject" | "accept";
export type AutoConsentOption = boolean | "reject" | "accept";

/**
 * What a session filters and dismisses, with its counters. Part of the session
 * details as `pageFilters`; the counters survive park and resume.
 */
export interface PageFilters {
  blockAds: boolean;
  blockPrivateNetwork: boolean;
  saveData: boolean;
  autoConsent: AutoConsentMode;
  /** Requests refused so far, all reasons together. */
  requestsBlocked: number;
  blocked: Record<BlockKind, number>;
  /** Consent banners that went away after the session clicked their button. */
  bannersDismissed: number;
  lastBanner?: {
    at: string;
    manager: string;
    action: "reject" | "accept";
    label: string;
    url: string;
  };
}

/** `true` means "reject": a banner is only ever accepted when the caller says so. */
export function normalizeAutoConsent(value: AutoConsentOption | undefined): AutoConsentMode {
  if (value === true || value === "reject") return "reject";
  if (value === "accept") return "accept";
  return "off";
}

/** `saveData` skips images, media and fonts on top of whatever `optimizeBandwidth` asks. */
export function applySaveData(
  optimize: OptimizeBandwidthOptions | undefined,
  saveData: boolean | undefined,
): OptimizeBandwidthOptions | undefined {
  if (!saveData) return optimize;
  return { ...(optimize ?? {}), blockImages: true, blockMedia: true, blockFonts: true };
}

export function createPageFilters(
  options: {
    blockAds?: boolean;
    blockPrivateNetwork?: boolean;
    saveData?: boolean;
    autoConsent?: AutoConsentOption;
  },
  previous?: Partial<PageFilters>,
): PageFilters {
  const blocked = {
    ads: 0,
    rules: 0,
    images: 0,
    media: 0,
    fonts: 0,
    stylesheets: 0,
    private: 0,
    ...(previous?.blocked ?? {}),
  };
  return {
    blockAds: !!options.blockAds,
    blockPrivateNetwork: !!options.blockPrivateNetwork,
    saveData: !!options.saveData,
    autoConsent: normalizeAutoConsent(options.autoConsent),
    requestsBlocked: previous?.requestsBlocked ?? 0,
    blocked,
    bannersDismissed: previous?.bannersDismissed ?? 0,
    ...(previous?.lastBanner ? { lastBanner: previous.lastBanner } : {}),
  };
}

export function countBlocked(filters: PageFilters, kind: BlockKind): void {
  filters.requestsBlocked += 1;
  filters.blocked[kind] = (filters.blocked[kind] ?? 0) + 1;
}
