import { describe, expect, it } from "vitest";
import { AD_HOSTS, createAdMatcher, createHostMatcher, parseHostList } from "./ad-hosts.js";

describe("built-in ad host list", () => {
  it("holds a few hundred well-formed, unique, lower-case host names", () => {
    expect(AD_HOSTS.length).toBeGreaterThanOrEqual(300);
    expect(new Set(AD_HOSTS).size).toBe(AD_HOSTS.length);
    for (const host of AD_HOSTS) {
      expect(host).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/);
    }
  });

  it("leaves consent managers and common content hosts alone", () => {
    const match = createAdMatcher();
    for (const host of [
      "cdn.cookielaw.org",
      "consent.cookiebot.com",
      "sdk.privacy-center.org",
      "app.usercentrics.eu",
      "www.google.com",
      "fonts.gstatic.com",
      "www.youtube.com",
      "cdn.jsdelivr.net",
      "www.facebook.com",
      "js.stripe.com",
      "example.com",
    ]) {
      expect(match(host), host).toBeUndefined();
    }
  });
});

describe("createHostMatcher", () => {
  const match = createHostMatcher(["doubleclick.net", "ads.example.com", "Tracker.Test."]);

  it("matches the listed domain and its subdomains, reporting the entry", () => {
    expect(match("doubleclick.net")).toBe("doubleclick.net");
    expect(match("stats.g.doubleclick.net")).toBe("doubleclick.net");
    expect(match("ADS.example.com.")).toBe("ads.example.com");
    expect(match("a.b.ads.example.com")).toBe("ads.example.com");
    expect(match("tracker.test")).toBe("tracker.test");
  });

  it("matches whole labels only", () => {
    expect(match("notdoubleclick.net")).toBeUndefined();
    expect(match("doubleclick.net.evil.org")).toBeUndefined();
    expect(match("example.com")).toBeUndefined();
    expect(match("www.example.com")).toBeUndefined();
    expect(match("net")).toBeUndefined();
    expect(match("")).toBeUndefined();
  });

  it("prefers the most specific entry", () => {
    const nested = createHostMatcher(["example.com", "ads.example.com"]);
    expect(nested("x.ads.example.com")).toBe("ads.example.com");
    expect(nested("www.example.com")).toBe("example.com");
  });

  it("never matches an allowed host or its subdomains", () => {
    const allowing = createHostMatcher(["example.com"], ["shop.example.com"]);
    expect(allowing("ads.example.com")).toBe("example.com");
    expect(allowing("shop.example.com")).toBeUndefined();
    expect(allowing("cdn.shop.example.com")).toBeUndefined();
  });
});

describe("operator host lists", () => {
  it("parses comma, space and newline separated values and drops junk", () => {
    expect(
      parseHostList(" Tracker.Localhost, ads.test\nfoo.example.  ,http://bad/,*.wild.com,,"),
    ).toEqual(["tracker.localhost", "ads.test", "foo.example"]);
    expect(parseHostList(undefined)).toEqual([]);
    expect(parseHostList("")).toEqual([]);
  });

  it("adds extra hosts to the built-in list and applies the allow list to both", () => {
    const match = createAdMatcher("tracker.localhost", "googletagmanager.com");
    expect(match("tracker.localhost")).toBe("tracker.localhost");
    expect(match("pixel.tracker.localhost")).toBe("tracker.localhost");
    expect(match("stats.g.doubleclick.net")).toBe("doubleclick.net");
    expect(match("www.googletagmanager.com")).toBeUndefined();
    expect(match("localhost")).toBeUndefined();
  });
});
