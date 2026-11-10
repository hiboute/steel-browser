import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { expect, it, vi } from "vitest";
import { HandoffService } from "../handoff.service.js";
import { TimelineService } from "../timeline.service.js";
import { RecordingService } from "../recording.service.js";
import { PlatformStore } from "../platform/store.js";
import type { Session } from "../session.service.js";

const chrome =
  process.env.CHROME_EXECUTABLE_PATH ||
  (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);

it.skipIf(!chrome)(
  "records real Chrome frames, captures a small timeline image, and completes a human condition",
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "steel-agent-browser-"));
    const browser = await puppeteer.launch({
      executablePath: chrome,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      userDataDir: path.join(directory, "chrome"),
    });
    const logger = new EventEmitter();
    const session = {
      id: "real-browser",
      status: "live",
      isSelenium: false,
      cdpService: {
        getAllPages: () => browser.pages(),
        getTargetId: (page: any) => page.target()._targetId,
        getInstrumentationLogger: () => logger,
      },
    } as unknown as Session;
    const store = new PlatformStore(path.join(directory, "data"));
    const base = {
      store,
      getSession: (id: string) => (id === session.id ? session : undefined),
      publish: vi.fn(),
      log: vi.fn(),
    };
    const recordings = new RecordingService(base);
    const timeline = new TimelineService(base);
    const handoffs = new HandoffService({
      ...base,
      notify: async () => {},
      changed: async () => {},
      viewerUrl: "https://steel.test",
    });
    try {
      await Promise.all([recordings.initialize(), handoffs.initialize()]);
      const [page] = await browser.pages();
      await page.setViewport({ width: 960, height: 640 });
      await page.setContent(
        '<html><body style="background:#ddd"><h1>Waiting for human</h1><button id="done" onclick="this.id=\'complete\'">Done</button></body></html>',
      );
      await recordings.start(session.id);
      await handoffs.create(
        session.id,
        {
          reason: "Click Done",
          doneWhen: { selector: "#complete", selectorGone: "#done" },
          notify: false,
        },
        "test",
      );
      await handoffs.poll();
      expect(handoffs.isWaiting(session.id)).toBe(true);
      await page.click("#done");
      await handoffs.poll();
      expect(handoffs.get(session.id)?.status).toBe("done");
      await vi.waitFor(
        async () => expect((await recordings.frames(session.id)).length).toBeGreaterThan(0),
        { timeout: 6000 },
      );
      const entry = await timeline.append(session.id, { tool: "clicked", screenshot: true });
      expect(entry.screenshot).toBe(true);
      const jpeg = await timeline.image(session.id, entry.seq);
      expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      const frame = await recordings.image(session.id, 1);
      expect(frame.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      await recordings.stop(session.id, "parked");
      expect(recordings.get(session.id)).toMatchObject({ status: "stopped", stopReason: "parked" });
      expect(base.log).not.toHaveBeenCalled();
    } finally {
      await handoffs.close();
      await recordings.close();
      await timeline.close();
      await browser.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  20000,
);
