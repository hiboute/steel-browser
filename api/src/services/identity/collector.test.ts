import { describe, expect, it, vi } from "vitest";
import type { Browser, Page } from "puppeteer-core";
import { IdentityCollector } from "./collector.js";

describe("identity collector target readiness", () => {
  it.each([undefined, "http://collector.example"])(
    "waits for identity setup before collecting headers (%s)",
    async (origin) => {
      const collector = new IdentityCollector(origin);
      let ready = false;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const page = {
        goto: vi.fn(async () => { expect(ready).toBe(true); }),
        evaluate: vi.fn(async () => ({ "user-agent": ready ? "Chrome/149" : "HeadlessChrome/149" })),
        close: vi.fn(async () => {}),
      };
      const browser = { newPage: async () => page } as unknown as Browser;
      const prepare = vi.fn(async (target: Page) => {
        expect(target).toBe(page);
        await gate;
        ready = true;
      });
      const result = collector.headers(browser, prepare);
      try {
        await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
        expect(page.goto).not.toHaveBeenCalled();
        expect(page.evaluate).not.toHaveBeenCalled();
        release();
        expect(await result).toMatchObject({status: "measured", headers: {"user-agent": "Chrome/149"}});
        expect(page.close).toHaveBeenCalledOnce();
      } finally {
        release();
        await collector.close();
      }
    },
  );

  it("closes a diagnostic page when target setup fails instead of measuring an unconfigured browser", async () => {
    const collector = new IdentityCollector();
    const page = {goto: vi.fn(), close: vi.fn(async () => {})};
    const browser = {newPage: async () => page} as unknown as Browser;
    try {
      const result = await collector.headers(browser, async () => {throw Error("Target setup failed");});
      expect(result.status).toBe("unavailable");
      expect(page.goto).not.toHaveBeenCalled();
      expect(page.close).toHaveBeenCalledOnce();
    } finally {
      await collector.close();
    }
  });
});
