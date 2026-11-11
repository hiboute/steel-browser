import { describe, expect, it } from "vitest";
import { createHostMatcher } from "./ad-hosts.js";
import { blockReason, compileUrlPatterns, normalizeHosts, type RequestFilter } from "./requests.js";

const ads = createHostMatcher(["doubleclick.net", "hotjar.com", "tracker.localhost"]);
const page = "https://shop.example.com/cart";
const sub = (url: string, resourceType = "script") => ({ url, resourceType, pageUrl: page });

describe("blockReason", () => {
  it("lets everything through without filters", () => {
    expect(
      blockReason(sub("https://stats.g.doubleclick.net/pixel.gif", "image"), {}),
    ).toBeUndefined();
    expect(blockReason(sub("https://shop.example.com/font.woff2", "font"), {})).toBeUndefined();
  });

  it("blocks subresources of listed ad hosts", () => {
    const filter: RequestFilter = { ads };
    expect(blockReason(sub("https://stats.g.doubleclick.net/pixel.gif", "image"), filter)).toBe(
      "ads",
    );
    expect(blockReason(sub("http://tracker.localhost:8080/t.js"), filter)).toBe("ads");
    expect(blockReason(sub("https://static.hotjar.com/c/hotjar.js"), filter)).toBe("ads");
    expect(blockReason(sub("https://shop.example.com/app.js"), filter)).toBeUndefined();
    expect(blockReason(sub("https://example.com/?next=doubleclick.net"), filter)).toBeUndefined();
  });

  it("always loads the document the session navigates to", () => {
    const filter: RequestFilter = { ads, images: true, media: true, fonts: true };
    expect(
      blockReason(
        {
          url: "https://ad.doubleclick.net/clk?u=1",
          resourceType: "document",
          mainFrameNavigation: true,
        },
        filter,
      ),
    ).toBeUndefined();
    expect(
      blockReason(
        {
          url: "https://shop.example.com/photo.png",
          resourceType: "document",
          mainFrameNavigation: true,
        },
        filter,
      ),
    ).toBeUndefined();
    // An ad iframe is a document too, but not the one the session asked for.
    expect(blockReason(sub("https://ad.doubleclick.net/frame.html", "document"), filter)).toBe(
      "ads",
    );
  });

  it("does not block a listed site's own resources while it is the page", () => {
    const filter: RequestFilter = { ads };
    const onHotjar = (url: string) =>
      blockReason(
        { url, resourceType: "script", pageUrl: "https://insights.hotjar.com/home" },
        filter,
      );
    expect(onHotjar("https://static.hotjar.com/app.js")).toBeUndefined();
    expect(onHotjar("https://stats.g.doubleclick.net/t.js")).toBe("ads");
  });

  it("uses the Referer for the same exemption while the page URL is unknown", () => {
    const filter: RequestFilter = { ads };
    const from = (referrer: string | undefined, pageUrl?: string) =>
      blockReason(
        { url: "https://static.hotjar.com/app.js", resourceType: "script", referrer, pageUrl },
        filter,
      );
    expect(from("https://insights.hotjar.com/")).toBeUndefined();
    expect(from("https://insights.hotjar.com/", "about:blank")).toBeUndefined();
    expect(from("https://shop.example.com/")).toBe("ads");
    expect(from(undefined)).toBe("ads");
    expect(from("not a url")).toBe("ads");
  });

  it("skips images, media and fonts by resource type", () => {
    const filter: RequestFilter = { images: true, media: true, fonts: true };
    expect(blockReason(sub("https://cdn.example.com/a", "image"), filter)).toBe("images");
    expect(blockReason(sub("https://cdn.example.com/a", "media"), filter)).toBe("media");
    expect(blockReason(sub("https://cdn.example.com/a", "font"), filter)).toBe("fonts");
    expect(blockReason(sub("https://cdn.example.com/a.css", "stylesheet"), filter)).toBeUndefined();
    expect(blockReason(sub("https://cdn.example.com/a.js", "script"), filter)).toBeUndefined();
    expect(blockReason(sub("https://cdn.example.com/api", "xhr"), filter)).toBeUndefined();
    expect(
      blockReason(sub("https://cdn.example.com/a.css", "stylesheet"), { stylesheets: true }),
    ).toBe("stylesheets");
  });

  it("uses the extension only for requests without a telling type", () => {
    const filter: RequestFilter = { images: true, media: true, fonts: true };
    expect(blockReason(sub("https://cdn.example.com/a.png?v=2", "fetch"), filter)).toBe("images");
    expect(blockReason(sub("https://cdn.example.com/seg-1.m4s", "xhr"), filter)).toBe("media");
    expect(blockReason(sub("https://cdn.example.com/inter.woff2", "other"), filter)).toBe("fonts");
    // A TypeScript module is not an MPEG transport stream.
    expect(blockReason(sub("https://cdn.example.com/main.ts", "script"), filter)).toBeUndefined();
  });

  it("leaves data, blob and extension URLs alone", () => {
    const filter: RequestFilter = { ads, images: true, fonts: true, media: true };
    expect(blockReason(sub("data:image/png;base64,AAAA", "image"), filter)).toBeUndefined();
    expect(blockReason(sub("blob:https://shop.example.com/1234", "media"), filter)).toBeUndefined();
    expect(blockReason(sub("chrome-extension://abc/font.woff2", "font"), filter)).toBeUndefined();
  });

  it("applies operator host and pattern rules to everything, navigations included", () => {
    const filter: RequestFilter = {
      hosts: normalizeHosts(["Blocked.example"]),
      urlPatterns: compileUrlPatterns(["*/private/*"]),
    };
    expect(
      blockReason(
        {
          url: "https://www.blocked.example/",
          resourceType: "document",
          mainFrameNavigation: true,
        },
        filter,
      ),
    ).toBe("rules");
    expect(blockReason(sub("https://shop.example.com/private/x.js"), filter)).toBe("rules");
    expect(blockReason(sub("https://shop.example.com/public/x.js"), filter)).toBeUndefined();
  });

  it("does not throw on a URL it cannot parse", () => {
    expect(blockReason(sub("not a url"), { ads, images: true })).toBeUndefined();
  });
});
