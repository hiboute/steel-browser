import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import puppeteer, { type Browser } from "puppeteer-core";
import { expect, it, vi } from "vitest";
import { SessionService, type Session } from "./session.service.js";

const chrome =
  process.env.CHROME_EXECUTABLE_PATH ||
  (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);

it.skipIf(!chrome)(
  "restores parked sessionStorage once and preserves newer values on same-origin navigation",
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "steel-storage-restore-"));
    const origin = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(
        '<html><body><script>document.body.dataset.initialDraft = sessionStorage.getItem("draft") || "missing";</script></body></html>',
      );
    });
    let browser: Browser | undefined;
    try {
      await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
      const address = origin.address();
      if (!address || typeof address === "string") throw new Error("Test origin did not start");
      const url = `http://127.0.0.1:${address.port}`;
      browser = await puppeteer.launch({
        executablePath: chrome,
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
        userDataDir: path.join(directory, "chrome"),
      });
      const [page] = await browser.pages();
      const cdpService = {
        getAllPages: async () => [page],
        getUserAgent: () => "test",
        getDimensions: () => ({ width: 800, height: 600 }),
        createPage: () => browser!.newPage(),
      };
      const service = new SessionService({
        browserPool: { primary: { cdpService }, allSlots: [] } as never,
        seleniumService: {} as never,
        fileService: {} as never,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      });
      const session = { cdpService } as unknown as Session;
      const restore = service as unknown as {
        restoreTabs(
          session: Session,
          snapshot: {
            tabs: Array<{
              url: string;
              title: string;
              active: boolean;
              scrollX: number;
              scrollY: number;
              storage: Record<string, string>;
            }>;
          },
        ): Promise<void>;
      };
      await restore.restoreTabs(session, {
        tabs: [
          {
            url: `${url}/restored`,
            title: "Draft",
            active: true,
            scrollX: 0,
            scrollY: 0,
            storage: { draft: "parked-value" },
          },
        ],
      });
      // The parked value must be available before the application's initial script runs.
      expect(await page.evaluate(() => document.body.dataset.initialDraft)).toBe("parked-value");
      await page.evaluate(() => sessionStorage.setItem("draft", "newer-value"));
      await page.goto(`${url}/next`, { waitUntil: "domcontentloaded" });
      expect(await page.evaluate(() => sessionStorage.getItem("draft"))).toBe("newer-value");
      expect(await page.evaluate(() => document.body.dataset.initialDraft)).toBe("newer-value");
      await page.reload({ waitUntil: "domcontentloaded" });
      expect(await page.evaluate(() => sessionStorage.getItem("draft"))).toBe("newer-value");
    } finally {
      await browser?.close();
      await new Promise<void>((resolve) => origin.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
  20000,
);
