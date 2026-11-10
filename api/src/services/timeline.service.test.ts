import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlatformStore } from "./platform/store.js";
import { TimelineService } from "./timeline.service.js";
import { BrowserEventType, EmitEvent } from "../types/enums.js";
import type { Session } from "./session.service.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.useRealTimers();
});

async function setup(maxEntries = 2000) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "steel-timeline-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = new PlatformStore(directory, "test-key");
  const logger = new EventEmitter();
  const session = {
    id: "s1",
    status: "live",
    cdpService: { getInstrumentationLogger: () => logger },
  } as unknown as Session;
  const sessions = new Map([[session.id, session]]);
  const deps = {
    store,
    getSession: (id: string) => sessions.get(id),
    publish: vi.fn(),
    log: vi.fn(),
    maxEntries,
    retentionDays: 7,
  };
  const service = new TimelineService(deps);
  cleanup.push(() => service.close());
  return { service, deps, store, session, sessions, logger };
}

describe("session timeline", () => {
  it("serializes concurrent appends, caps history and resumes sequence numbers after restart", async () => {
    const { service, deps } = await setup(2);
    const entries = await Promise.all(
      [1, 2, 3].map((n) => service.append("s1", { tool: `tool-${n}` }, "client")),
    );
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect((await service.read("s1")).map((entry) => entry.seq)).toEqual([2, 3]);
    const restarted = new TimelineService(deps);
    cleanup.push(() => restarted.close());
    expect(await restarted.append("s1", { tool: "next" })).toMatchObject({ seq: 4 });
    expect((await restarted.read("s1", 3)).map((entry) => entry.seq)).toEqual([4]);
  });

  it("redacts nested credentials and password input before persistence and events", async () => {
    const { service, store, deps } = await setup();
    const entry = await service.append("s1", {
      tool: "browser_type",
      args: {
        selector: "input[type=password]",
        text: "do-not-store",
        nested: { token: "secret-token", okay: "safe" },
      },
    });
    expect(entry.args).toEqual({
      selector: "input[type=password]",
      text: "[redacted]",
      nested: { token: "[redacted]", okay: "safe" },
    });
    expect(JSON.stringify(deps.publish.mock.calls)).not.toContain("do-not-store");
    const raw = await readFile(store.path("timeline/s1/entries.jsonl"), "utf8");
    expect(raw).not.toContain("safe");
    expect(raw).not.toContain("secret-token");
    expect((await service.read("s1"))[0].args).toEqual(entry.args);
  });

  it("records main page navigation and detaches the browser listener when the session ends", async () => {
    const { service, logger, session } = await setup();
    service.attach(session);
    logger.emit(EmitEvent.Log, {
      type: BrowserEventType.Navigation,
      targetType: "page",
      navigation: { url: "https://example.test/" },
    });
    expect((await service.read("s1"))[0]).toMatchObject({
      kind: "navigation",
      url: "https://example.test/",
    });
    service.detachSession("s1");
    expect(logger.listenerCount(EmitEvent.Log)).toBe(0);
    logger.emit(EmitEvent.Log, {
      type: BrowserEventType.Navigation,
      navigation: { url: "https://other.test/" },
    });
    expect(await service.read("s1")).toHaveLength(1);
  });

  it.each([
    { selector: "#login", inputType: "password", text: "typed-password" },
    { selector: "#login", type: "password", value: "typed-password" },
    { selector: "#login", target: { type: "password" }, text: "typed-password" },
    {
      selector: "#login",
      target: { attributes: { type: "password" } },
      args: { text: "typed-password" },
    },
  ])(
    "redacts explicit password metadata even when the selector looks innocuous: %j",
    async (args) => {
      const { service, deps } = await setup();
      await service.append("s1", { tool: "browser_type", args });
      expect(JSON.stringify(await service.read("s1"))).not.toContain("typed-password");
      expect(JSON.stringify(deps.publish.mock.calls)).not.toContain("typed-password");
    },
  );

  it("expires old released timelines while retaining a live session", async () => {
    const { service, sessions, store } = await setup();
    vi.useFakeTimers({ toFake: ["Date"] });
    await service.append("old", { tool: "done" });
    await service.append("s1", { tool: "still-live" });
    vi.setSystemTime(Date.now() + 8 * 86400000);
    await service.sweep();
    expect(await store.list("timeline")).toEqual(["s1"]);
    sessions.clear();
    await service.sweep();
    expect(await store.list("timeline")).toEqual([]);
  });

  it("rejects path traversal and absent screenshots", async () => {
    const { service } = await setup();
    expect(() => service.append("../../escape", { tool: "x" })).toThrow("Invalid session ID");
    await expect(service.image("s1", 1)).rejects.toMatchObject({ code: "screenshot_not_found" });
  });
});
