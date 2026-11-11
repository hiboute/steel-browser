import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../session.service.js";
import { ConsentService, type ConsentEvent } from "./consent.service.js";
import { createPage } from "./__tests__/fixture.js";

const BANNER = `
  <main><button id="buy">Buy now</button></main>
  <div id="onetrust-banner-sdk">
    <p>We use cookies.</p>
    <button id="onetrust-reject-all-handler">Reject All</button>
    <button id="onetrust-accept-btn-handler">Accept All Cookies</button>
  </div>`;
const ACCEPT_ONLY = BANNER.replace(/<button id="onetrust-reject-all-handler">.*?<\/button>/, "");

/** A puppeteer page whose frame evaluates against a jsdom document. */
function fakeSession(html: string, url = "https://shop.example.com/") {
  const dom = createPage(html, url);
  const clicks: string[] = [];
  dom.document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    clicks.push(target.id || target.textContent || "");
    // The banner closes whichever of its buttons is used.
    target.closest("#onetrust-banner-sdk")?.setAttribute("data-off", "");
  });
  const frame = {
    detached: false,
    url: () => url,
    evaluateHandle: async (_fn: unknown, config: any) => {
      const result = dom.scan(config);
      return {
        evaluate: async (fn: (...args: any[]) => unknown, ...args: unknown[]) =>
          fn(result, ...args),
        dispose: async () => undefined,
      };
    },
  };
  const page = Object.assign(new EventEmitter(), {
    isClosed: () => false,
    url: () => url,
    mainFrame: () => frame,
    frames: () => [frame],
  });
  const browser = Object.assign(new EventEmitter(), { pages: async () => [page] });
  const session = {
    id: "s1",
    status: "live",
    isSelenium: false,
    cdpService: { getBrowserInstance: () => browser },
  } as unknown as Session;
  return { session, page, browser, frame, clicks, dom };
}

function service(session: Session, paused: () => string | undefined = () => undefined) {
  const events: ConsentEvent[] = [];
  const errors: unknown[] = [];
  const consent = new ConsentService({
    getSession: (id) => (id === session.id ? session : undefined),
    paused,
    record: (event) => void events.push(event),
    log: (error) => void errors.push(error),
    delays: [100, 1000],
  });
  return { consent, events, errors };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ConsentService", () => {
  it("rejects a banner once and records what it clicked", async () => {
    vi.useFakeTimers();
    const fake = fakeSession(BANNER);
    const { consent, events, errors } = service(fake.session);
    await consent.attach(fake.session, "reject");
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.clicks).toEqual(["onetrust-reject-all-handler"]);
    expect(events).toEqual([
      {
        sessionId: "s1",
        url: "https://shop.example.com/",
        manager: "onetrust",
        action: "reject",
        label: "Reject All",
        dismissed: true,
      },
    ]);
    expect(errors).toEqual([]);
  });

  it("leaves an accept-only banner alone in reject mode and accepts it in accept mode", async () => {
    vi.useFakeTimers();
    const rejecting = fakeSession(ACCEPT_ONLY);
    const first = service(rejecting.session);
    await first.consent.attach(rejecting.session, "reject");
    await vi.advanceTimersByTimeAsync(5000);
    expect(rejecting.clicks).toEqual([]);
    expect(first.events).toEqual([]);

    const accepting = fakeSession(ACCEPT_ONLY);
    const second = service(accepting.session);
    await second.consent.attach(accepting.session, "accept");
    await vi.advanceTimersByTimeAsync(5000);
    expect(accepting.clicks).toEqual(["onetrust-accept-btn-handler"]);
    expect(second.events[0]).toMatchObject({ action: "accept", dismissed: true });
  });

  it("clicks nothing while the session waits for a person, then resumes", async () => {
    vi.useFakeTimers();
    const fake = fakeSession(BANNER);
    let reason: string | undefined = "handoff";
    const { consent, events } = service(fake.session, () => reason);
    await consent.attach(fake.session, "reject");
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.clicks).toEqual([]);
    reason = undefined;
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.clicks).toEqual(["onetrust-reject-all-handler"]);
    expect(events).toHaveLength(1);
  });

  it("clicks nothing in a session that is not live", async () => {
    vi.useFakeTimers();
    const fake = fakeSession(BANNER);
    (fake.session as any).status = "parked";
    const { consent } = service(fake.session);
    await consent.attach(fake.session, "reject");
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.clicks).toEqual([]);
  });

  it("stops after two clicks on a banner that does not go away", async () => {
    vi.useFakeTimers();
    const fake = fakeSession(BANNER);
    // This banner ignores its buttons.
    fake.dom.document.addEventListener(
      "click",
      (event) => (event.target as HTMLElement).closest("[data-off]")?.removeAttribute("data-off"),
    );
    const events: ConsentEvent[] = [];
    const consent = new ConsentService({
      getSession: () => fake.session,
      paused: () => undefined,
      record: (event) => void events.push(event),
      log: () => undefined,
      delays: [100, 1500, 3000, 4500, 6000],
    });
    await consent.attach(fake.session, "reject");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fake.clicks).toHaveLength(2);
    expect(events.map((event) => event.dismissed)).toEqual([false, false]);
  });

  it("looks again after a navigation and stops when detached", async () => {
    vi.useFakeTimers();
    const fake = fakeSession(BANNER);
    const { consent } = service(fake.session);
    await consent.attach(fake.session, "reject");
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.clicks).toHaveLength(1);

    // The next document shows its banner again.
    fake.dom.document.querySelector("#onetrust-banner-sdk")!.removeAttribute("data-off");
    fake.page.emit("framenavigated", fake.frame);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.clicks).toHaveLength(2);

    fake.dom.document.querySelector("#onetrust-banner-sdk")!.removeAttribute("data-off");
    consent.detach("s1");
    expect(consent.isAttached("s1")).toBe(false);
    fake.page.emit("framenavigated", fake.frame);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fake.clicks).toHaveLength(2);
    expect(fake.page.listenerCount("framenavigated")).toBe(0);
    expect(fake.browser.listenerCount("targetcreated")).toBe(0);
  });

  it("does not watch Selenium sessions", async () => {
    const fake = fakeSession(BANNER);
    (fake.session as any).isSelenium = true;
    const { consent } = service(fake.session);
    await consent.attach(fake.session, "reject");
    expect(consent.isAttached("s1")).toBe(false);
  });
});
