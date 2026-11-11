import { describe, expect, it } from "vitest";
import browserSchemas from "../modules/sessions/sessions.schema.js";
import {
  applySaveData,
  countBlocked,
  createPageFilters,
  normalizeAutoConsent,
} from "./page-filters.js";

const create = (body: Record<string, unknown>) => browserSchemas.CreateSession.safeParse(body);

describe("session create options", () => {
  it("accepts the three options and their absence", () => {
    expect(create({}).success).toBe(true);
    expect(create({ blockAds: true, saveData: true, autoConsent: "reject" }).success).toBe(true);
    expect(create({ blockAds: false, saveData: false, autoConsent: false }).success).toBe(true);
    expect(create({ autoConsent: "accept" }).success).toBe(true);
    expect(create({ autoConsent: true }).success).toBe(true);
    expect(create({ optimizeBandwidth: { blockFonts: true } }).success).toBe(true);
  });

  it("rejects values of the wrong type", () => {
    expect(create({ blockAds: "yes" }).success).toBe(false);
    expect(create({ saveData: 1 }).success).toBe(false);
    expect(create({ saveData: "true" }).success).toBe(false);
    expect(create({ autoConsent: "decline" }).success).toBe(false);
    expect(create({ autoConsent: "" }).success).toBe(false);
    expect(create({ autoConsent: 1 }).success).toBe(false);
    expect(create({ autoConsent: { mode: "reject" } }).success).toBe(false);
    expect(create({ optimizeBandwidth: { blockScripts: true } }).success).toBe(false);
  });

  it("describes the counters in the session details", () => {
    const details = browserSchemas.SessionDetails.shape.pageFilters;
    const filters = createPageFilters({ blockAds: true, autoConsent: "accept" });
    expect(details.safeParse(filters).success).toBe(true);
    expect(details.safeParse(undefined).success).toBe(true);
    expect(details.safeParse({ ...filters, autoConsent: true }).success).toBe(false);
  });
});

describe("normalizeAutoConsent", () => {
  it("never accepts unless asked to", () => {
    expect(normalizeAutoConsent(undefined)).toBe("off");
    expect(normalizeAutoConsent(false)).toBe("off");
    expect(normalizeAutoConsent(true)).toBe("reject");
    expect(normalizeAutoConsent("reject")).toBe("reject");
    expect(normalizeAutoConsent("accept")).toBe("accept");
    expect(normalizeAutoConsent("yes" as never)).toBe("off");
  });
});

describe("applySaveData", () => {
  it("leaves the bandwidth options alone when off", () => {
    expect(applySaveData(undefined, undefined)).toBeUndefined();
    expect(applySaveData(undefined, false)).toBeUndefined();
    const optimize = { blockStylesheets: true };
    expect(applySaveData(optimize, false)).toBe(optimize);
  });

  it("skips images, media and fonts, keeping what optimizeBandwidth asked", () => {
    expect(applySaveData(undefined, true)).toEqual({
      blockImages: true,
      blockMedia: true,
      blockFonts: true,
    });
    expect(applySaveData({ blockImages: false, blockHosts: ["a.test"] }, true)).toEqual({
      blockImages: true,
      blockMedia: true,
      blockFonts: true,
      blockHosts: ["a.test"],
    });
  });
});

describe("page filter counters", () => {
  it("starts at zero with the options that are on", () => {
    expect(createPageFilters({})).toEqual({
      blockAds: false,
      saveData: false,
      autoConsent: "off",
      requestsBlocked: 0,
      blocked: { ads: 0, rules: 0, images: 0, media: 0, fonts: 0, stylesheets: 0 },
      bannersDismissed: 0,
    });
    expect(createPageFilters({ blockAds: true, saveData: true, autoConsent: true })).toMatchObject({
      blockAds: true,
      saveData: true,
      autoConsent: "reject",
    });
  });

  it("counts per reason and in total", () => {
    const filters = createPageFilters({ blockAds: true });
    countBlocked(filters, "ads");
    countBlocked(filters, "ads");
    countBlocked(filters, "fonts");
    expect(filters.requestsBlocked).toBe(3);
    expect(filters.blocked).toMatchObject({ ads: 2, fonts: 1, images: 0 });
  });

  it("carries counters over a park and resume without sharing objects", () => {
    const before = createPageFilters({ blockAds: true, autoConsent: "reject" });
    countBlocked(before, "images");
    before.bannersDismissed = 2;
    before.lastBanner = {
      at: "2026-01-01T00:00:00.000Z",
      manager: "onetrust",
      action: "reject",
      label: "Reject All",
      url: "https://example.com/",
    };
    const after = createPageFilters({ blockAds: true, autoConsent: "reject" }, before);
    countBlocked(after, "images");
    expect(after.requestsBlocked).toBe(2);
    expect(after.blocked.images).toBe(2);
    expect(after.bannersDismissed).toBe(2);
    expect(after.lastBanner?.manager).toBe("onetrust");
    expect(before.blocked.images).toBe(1);
  });
});
