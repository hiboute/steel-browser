import { describe, expect, it } from "vitest";
import { chooseConsentAction } from "./consent-rules.js";
import { scanConfigFor } from "./consent.service.js";
import { createPage } from "./__tests__/fixture.js";

const ONETRUST = `
  <div id="onetrust-consent-sdk"><div id="onetrust-banner-sdk" role="dialog">
    <p>We use cookies to improve your experience.</p>
    <button id="onetrust-pc-btn-handler">Cookies Settings</button>
    <button id="onetrust-reject-all-handler">Reject All</button>
    <button id="onetrust-accept-btn-handler">Accept All Cookies</button>
  </div></div>`;

describe("scanConsent", () => {
  it("reports a OneTrust banner with its own buttons flagged", () => {
    const { scan, document } = createPage(
      `<main><button id="buy">Buy now</button></main>${ONETRUST}`,
    );
    const result = scan();
    expect(result.containers).toEqual([
      {
        manager: "onetrust",
        buttons: [
          { label: "Reject All", reject: true },
          { label: "Accept All Cookies", accept: true },
          { label: "Cookies Settings" },
        ],
      },
    ]);
    const decision = chooseConsentAction(result.containers, "reject")!;
    expect(result.elements[decision.container][decision.button]).toBe(
      document.querySelector("#onetrust-reject-all-handler"),
    );
  });

  it("never reports a button outside a consent container", () => {
    const { scan } = createPage(`
      <main>
        <button>Reject all</button><button>Decline</button><button>Accept</button>
        <form><button type="submit">I agree</button></form>
      </main>`);
    expect(scan().containers).toEqual([]);
  });

  it("ignores a banner that is not rendered", () => {
    const hidden = ONETRUST.replace('id="onetrust-banner-sdk"', 'id="onetrust-banner-sdk" hidden');
    expect(createPage(hidden).scan().containers).toEqual([]);
    const styled = ONETRUST.replace(
      'id="onetrust-banner-sdk"',
      'id="onetrust-banner-sdk" style="display:none"',
    );
    expect(createPage(styled).scan().containers).toEqual([]);
  });

  it("skips hidden and disabled buttons of a visible banner", () => {
    const { scan } = createPage(
      ONETRUST.replace(
        'id="onetrust-reject-all-handler"',
        'id="onetrust-reject-all-handler" data-off',
      ).replace('id="onetrust-accept-btn-handler"', 'id="onetrust-accept-btn-handler" disabled'),
    );
    expect(scan().containers).toEqual([
      { manager: "onetrust", buttons: [{ label: "Cookies Settings" }] },
    ]);
  });

  it("looks into an open shadow root (Usercentrics)", () => {
    const { scan, document, window } = createPage(`<div id="usercentrics-root" data-off></div>`);
    const host = document.querySelector("#usercentrics-root")!;
    host.removeAttribute("data-off");
    // The host itself is an empty box; the banner is fixed-positioned inside.
    const real = window.Element.prototype.getBoundingClientRect;
    window.Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this === host)
        return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 } as DOMRect;
      return real.call(this);
    };
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<div><button data-testid="uc-deny-all-button">Alles ablehnen</button>
      <button data-testid="uc-accept-all-button">Alles akzeptieren</button></div>`;
    const result = scan();
    expect(result.containers).toEqual([
      {
        manager: "usercentrics",
        buttons: [
          { label: "Alles ablehnen", reject: true },
          { label: "Alles akzeptieren", accept: true },
        ],
      },
    ]);
    expect(chooseConsentAction(result.containers, "reject")).toMatchObject({ action: "reject" });
  });

  it("recognises a generic cookie banner by attributes, text and exact labels", () => {
    const { scan } = createPage(`
      <div class="site-cookie-banner">
        <p>This site uses cookies to offer you a better browsing experience.</p>
        <a href="/privacy">Privacy policy</a>
        <a href="#" role="button">Customise</a>
        <button aria-label="Reject all">X</button>
        <button>Accept all</button>
      </div>`);
    const result = scan();
    expect(result.containers).toEqual([
      {
        manager: "generic",
        generic: true,
        labels: true,
        buttons: [
          { label: "Customise" },
          { label: "Reject all", text: "X" },
          { label: "Accept all" },
        ],
      },
    ]);
    // The aria-label and the visible "X" do not contradict: X is on no list.
    expect(chooseConsentAction(result.containers, "reject")).toMatchObject({ button: 1 });
  });

  it("reports the outermost generic container once", () => {
    const { scan } = createPage(`
      <section id="cookie-consent"><div class="cookie-consent__inner">
        <p>We use cookies and similar technologies on this website.</p>
        <button>Decline</button>
      </div></section>`);
    expect(scan().containers).toHaveLength(1);
  });

  it("does not treat forms, big sections or cookie-free text as banners", () => {
    const withField = `<div class="cookie-consent"><p>We use cookies. Enter your email for news.</p>
      <input type="email"><button>Accept</button></div>`;
    expect(createPage(withField).scan().containers).toEqual([]);
    const noCookieText = `<div class="consent-form"><p>I consent to the processing of this order.</p>
      <button>Accept</button><button>Decline</button></div>`;
    expect(createPage(noCookieText).scan().containers).toEqual([]);
    const manyButtons = `<div class="cookie-recipes"><p>Our best cookie recipes of the year.</p>
      ${"<button>Accept</button>".repeat(9)}</div>`;
    expect(createPage(manyButtons).scan().containers).toEqual([]);
    const article = `<article class="cookie-policy"><p>Our cookie policy explains cookies.</p>
      <button>Accept</button></article>`;
    expect(createPage(article).scan().containers).toEqual([]);
  });

  it("does not look for generic banners when told not to (child frames)", () => {
    const html = `<div class="cookie-banner"><p>We use cookies on this website.</p><button>Reject</button></div>`;
    const { scan } = createPage(html);
    expect(scan(scanConfigFor("https://ads.example.net/frame", false)).containers).toEqual([]);
    expect(scan(scanConfigFor("https://shop.example.com/", true)).containers).toHaveLength(1);
  });

  it("does not report a generic container around a known manager twice", () => {
    const { scan } = createPage(`<div class="cookie-wrapper">${ONETRUST}</div>`);
    expect(scan().containers.map((c) => c.manager)).toEqual(["onetrust"]);
  });

  it("treats Google's consent page as a container only on its own hosts", () => {
    const html = `<form action="https://consent.google.com/save"><button>Tout refuser</button></form>
      <form action="https://consent.google.com/save"><button>Tout accepter</button></form>`;
    expect(createPage(html, "https://shop.example.com/").scan().containers).toEqual([]);
    const result = createPage(html, "https://consent.google.fr/m?continue=x").scan();
    expect(result.containers).toEqual([
      {
        manager: "google-consent-page",
        labels: true,
        buttons: [{ label: "Tout refuser" }, { label: "Tout accepter" }],
      },
    ]);
    expect(chooseConsentAction(result.containers, "reject")).toMatchObject({
      label: "Tout refuser",
    });
  });

  it("survives selectors the engine does not support", () => {
    const { scan } = createPage(ONETRUST);
    const result = scan({
      rules: [
        { name: "broken", containers: ["div:has("], reject: ["]["], accept: [] },
        { name: "onetrust", containers: ["#onetrust-banner-sdk"], reject: ["]["], accept: [] },
      ],
      generic: false,
    });
    expect(result.containers.map((c) => c.manager)).toEqual(["onetrust"]);
  });
});

describe("scanConfigFor", () => {
  it("scans http(s) documents only", () => {
    expect(scanConfigFor("about:blank", true)).toBeUndefined();
    expect(scanConfigFor("chrome://settings", true)).toBeUndefined();
    expect(scanConfigFor("data:text/html,x", true)).toBeUndefined();
    expect(scanConfigFor("https://example.com/", true)?.generic).toBe(true);
    expect(scanConfigFor("https://example.com/", false)?.generic).toBe(false);
  });

  it("leaves host-bound rules out elsewhere", () => {
    const names = (url: string) => scanConfigFor(url, true)!.rules.map((rule) => rule.name);
    expect(names("https://example.com/")).not.toContain("google-consent-page");
    expect(names("https://consent.google.com/m")).toContain("google-consent-page");
    expect(names("https://example.com/")).toContain("onetrust");
  });
});
