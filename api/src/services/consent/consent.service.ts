import type { Browser, Frame, JSHandle, Page, Target } from "puppeteer-core";
import type { Session } from "../session.service.js";
import { bounded } from "../handoff/agent-feature-utils.js";
import {
  CONSENT_RULES,
  chooseConsentAction,
  ruleAppliesToHost,
  type ConsentAction,
  type ConsentContainer,
} from "./consent-rules.js";
import { scanConsent, type ScanConfig, type ScanResult } from "./consent-scan.js";

export interface ConsentEvent {
  sessionId: string;
  manager: string;
  action: ConsentAction;
  label: string;
  /** URL of the page (not of the banner's frame). */
  url: string;
  /** The clicked button went away, so the banner is counted as dismissed. */
  dismissed: boolean;
}

interface PageState {
  navigated: (frame: Frame) => void;
  timers: Set<NodeJS.Timeout>;
  /** Changes on every main-frame navigation; a scan of an older document stops. */
  generation: number;
  clicks: number;
  busy: boolean;
  /** A retry is waiting for a handoff, review or human control to end. */
  holding: boolean;
  holdRetries: number;
  /** Origins where a banner was already dismissed on this page. */
  settled: Set<string>;
}

interface Entry {
  mode: "reject" | "accept";
  browser: Browser;
  target: (target: Target) => void;
  pages: Map<Page, PageState>;
}

/** When a document is scanned after it starts loading, in milliseconds. */
export const CONSENT_SCAN_DELAYS = [400, 1200, 2500, 4500, 7000, 10_000, 15_000];
/** A banner already dismissed on this origin only gets two late looks. */
const SETTLED_SCAN_DELAYS = [2000, 6000];
const MAX_CLICKS_PER_DOCUMENT = 2;
const MAX_CHILD_FRAMES = 8;
const HOLD_RETRY_MS = 3000;
/** About ten minutes of waiting for a hold to end, per document. */
const MAX_HOLD_RETRIES = 200;
const CONFIRM_DELAY_MS = 800;

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** The scan configuration of one frame: host-bound rules only on their hosts, generic only on top. */
export function scanConfigFor(frameUrl: string, mainFrame: boolean): ScanConfig | undefined {
  if (!/^https?:/i.test(frameUrl)) return undefined;
  const host = hostOf(frameUrl);
  return {
    rules: CONSENT_RULES.filter((rule) => ruleAppliesToHost(rule, host)).map((rule) => ({
      name: rule.name,
      containers: rule.containers,
      reject: rule.reject,
      accept: rule.accept,
      labels: rule.labels,
    })),
    generic: mainFrame,
  };
}

/**
 * Dismisses cookie consent banners in sessions that asked for it.
 *
 * Each document is looked at a few times while it settles. A click only ever
 * lands on a button of an identified consent container (consent-rules.ts), and
 * never while the session waits for a person (handoff, review).
 */
export class ConsentService {
  private attached = new Map<string, Entry>();

  constructor(
    private d: {
      getSession: (id: string) => Session | undefined;
      /** Why nothing may be clicked in this session right now, if anything. */
      paused: (id: string) => string | undefined;
      record: (event: ConsentEvent) => void | Promise<void>;
      log: (error: unknown) => void;
      delays?: number[];
      holdRetryMs?: number;
    },
  ) {}

  isAttached(id: string): boolean {
    return this.attached.has(id);
  }

  async attach(session: Session, mode: "reject" | "accept"): Promise<void> {
    this.detach(session.id);
    if (session.isSelenium) return;
    const browser = session.cdpService.getBrowserInstance();
    if (!browser) return;
    const entry: Entry = { mode, browser, target: () => {}, pages: new Map() };
    const watch = (page: Page | null) => {
      if (!page || page.isClosed() || entry.pages.has(page)) return;
      if (this.attached.get(session.id) !== entry) return;
      const state: PageState = {
        navigated: (frame) => {
          if (frame === page.mainFrame()) this.arm(session.id, entry, page, state);
        },
        timers: new Set(),
        generation: 0,
        clicks: 0,
        busy: false,
        holding: false,
        holdRetries: 0,
        settled: new Set(),
      };
      entry.pages.set(page, state);
      page.on("framenavigated", state.navigated);
      page.once("close", () => this.unwatch(entry, page));
      this.arm(session.id, entry, page, state);
    };
    entry.target = (target) => {
      if (target.type() !== "page") return;
      void target.page().then(watch).catch(this.d.log);
    };
    this.attached.set(session.id, entry);
    browser.on("targetcreated", entry.target);
    for (const page of await browser.pages()) watch(page);
  }

  detach(id: string): void {
    const entry = this.attached.get(id);
    if (!entry) return;
    this.attached.delete(id);
    entry.browser.off("targetcreated", entry.target);
    for (const page of [...entry.pages.keys()]) this.unwatch(entry, page);
  }

  close(): void {
    for (const id of [...this.attached.keys()]) this.detach(id);
  }

  private unwatch(entry: Entry, page: Page) {
    const state = entry.pages.get(page);
    if (!state) return;
    entry.pages.delete(page);
    page.off("framenavigated", state.navigated);
    for (const timer of state.timers) clearTimeout(timer);
    state.timers.clear();
  }

  private arm(id: string, entry: Entry, page: Page, state: PageState) {
    for (const timer of state.timers) clearTimeout(timer);
    state.timers.clear();
    state.generation += 1;
    state.clicks = 0;
    state.holding = false;
    state.holdRetries = 0;
    const url = page.url();
    if (!/^https?:/i.test(url)) return;
    const generation = state.generation;
    const delays = state.settled.has(originOf(url))
      ? SETTLED_SCAN_DELAYS
      : this.d.delays ?? CONSENT_SCAN_DELAYS;
    for (const delay of delays) {
      const timer = setTimeout(() => {
        state.timers.delete(timer);
        void this.scan(id, entry, page, state, generation).catch(this.d.log);
      }, delay);
      timer.unref();
      state.timers.add(timer);
    }
  }

  private current(id: string, entry: Entry, page: Page, state: PageState, generation: number) {
    return (
      this.attached.get(id) === entry &&
      entry.pages.get(page) === state &&
      state.generation === generation &&
      !page.isClosed()
    );
  }

  /** A handoff, a review or a person's control outlasting the scan window
   * must not cost the document its scan: look again once the hold is over. */
  private retryAfterHold(
    id: string,
    entry: Entry,
    page: Page,
    state: PageState,
    generation: number,
  ) {
    const session = this.d.getSession(id);
    if (!session || session.status !== "live" || !this.d.paused(id)) return;
    if (state.holding || state.holdRetries >= MAX_HOLD_RETRIES) return;
    state.holding = true;
    state.holdRetries += 1;
    const timer = setTimeout(() => {
      state.timers.delete(timer);
      state.holding = false;
      void this.scan(id, entry, page, state, generation).catch(this.d.log);
    }, this.d.holdRetryMs ?? HOLD_RETRY_MS);
    timer.unref();
    state.timers.add(timer);
  }

  private allowed(id: string): boolean {
    const session = this.d.getSession(id);
    return !!session && session.status === "live" && !this.d.paused(id);
  }

  private async scan(id: string, entry: Entry, page: Page, state: PageState, generation: number) {
    if (state.busy || !this.current(id, entry, page, state, generation)) return;
    if (state.clicks >= MAX_CLICKS_PER_DOCUMENT) return;
    if (!this.allowed(id)) {
      this.retryAfterHold(id, entry, page, state, generation);
      return;
    }
    state.busy = true;
    try {
      // The address of the document being scanned: a consent click can navigate.
      const url = page.url();
      const main = page.mainFrame();
      const children = page
        .frames()
        .filter((frame) => frame !== main && !frame.detached && /^https?:/i.test(frame.url()))
        .slice(0, MAX_CHILD_FRAMES);
      for (const frame of [main, ...children]) {
        if (!this.current(id, entry, page, state, generation)) return;
        const outcome = await this.scanFrame(id, frame, frame === main, entry.mode, () =>
          this.current(id, entry, page, state, generation),
        );
        if (!outcome) continue;
        // The click may have loaded another document, whose scans are already
        // scheduled: only this document's state is touched.
        if (this.current(id, entry, page, state, generation)) {
          state.clicks += 1;
          if (outcome.dismissed) {
            for (const timer of state.timers) clearTimeout(timer);
            state.timers.clear();
          }
        }
        if (outcome.dismissed) state.settled.add(originOf(url));
        await this.d.record({ sessionId: id, url, ...outcome });
        return;
      }
    } finally {
      state.busy = false;
    }
  }

  private async scanFrame(
    id: string,
    frame: Frame,
    mainFrame: boolean,
    mode: "reject" | "accept",
    current: () => boolean,
  ): Promise<Omit<ConsentEvent, "sessionId" | "url"> | undefined> {
    const config = scanConfigFor(frame.url(), mainFrame);
    if (!config) return undefined;
    let handle: JSHandle<ScanResult> | undefined;
    try {
      // Puppeteer's own world: the page cannot see or tamper with the scan.
      const realm: Pick<Frame, "evaluateHandle"> = (frame as any).isolatedRealm?.() ?? frame;
      handle = (await bounded(
        realm.evaluateHandle(scanConsent, config),
        4000,
      )) as JSHandle<ScanResult>;
      const containers = (await bounded(
        handle.evaluate((result) => result.containers),
        3000,
      )) as ConsentContainer[];
      const decision = chooseConsentAction(containers, mode);
      if (!decision) return undefined;
      // The state may have changed while the page was being read.
      if (!current() || !this.allowed(id)) return undefined;
      const clicked = await bounded(
        handle.evaluate(
          (result, container, button) => {
            const element = result.elements[container]?.[button] as HTMLElement | undefined;
            if (!element || !result.visible(element)) return false;
            element.click();
            return true;
          },
          decision.container,
          decision.button,
        ),
        3000,
      );
      if (!clicked) return undefined;
      await new Promise((resolve) => setTimeout(resolve, CONFIRM_DELAY_MS));
      // A frame that went away with its banner (or navigated on submit) is gone too.
      const dismissed = await bounded(
        handle.evaluate(
          (result, container, button) => !result.visible(result.elements[container]?.[button]),
          decision.container,
          decision.button,
        ),
        3000,
      ).catch(() => true);
      return {
        manager: decision.manager,
        action: decision.action,
        label: decision.label,
        dismissed,
      };
    } catch (error) {
      // Frames come and go while a page loads; the next look will see the result.
      if (!frame.detached) this.d.log(error);
      return undefined;
    } finally {
      await handle?.dispose().catch(() => undefined);
    }
  }
}
