import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlatformStore } from "./platform/store.js";
import { RecordingService } from "./recording.service.js";
import type { Session } from "./session.service.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.useRealTimers();
});

function makePage(id: string) {
  const client = Object.assign(new EventEmitter(), {
    send: vi.fn().mockResolvedValue({}),
    detach: vi.fn().mockResolvedValue(undefined),
  });
  const page = {
    id,
    isClosed: () => false,
    url: () => `https://example.test/${id}`,
    evaluate: vi.fn().mockResolvedValue(true),
    createCDPSession: vi.fn().mockResolvedValue(client),
  };
  return { page, client };
}

async function setup(options: { maxBytes?: number; totalMaxBytes?: number } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "steel-recording-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = new PlatformStore(directory, "test-key");
  const { page, client } = makePage("page-1");
  const browser = {
    getAllPages: vi.fn().mockResolvedValue([page]),
    getTargetId: (p: { id: string }) => p.id,
  };
  const session = {
    id: "s1",
    status: "live",
    isSelenium: false,
    cdpService: browser,
  } as unknown as Session;
  const sessions = new Map([[session.id, session]]);
  const deps = {
    store,
    getSession: (id: string) => sessions.get(id),
    publish: vi.fn(),
    log: vi.fn(),
    ...options,
  };
  const service = new RecordingService(deps);
  await service.initialize();
  cleanup.push(() => service.close());
  return { service, deps, store, session, sessions, page, client, browser };
}

function frame(client: EventEmitter, content: string, timestamp = Date.now() / 1000) {
  client.emit("Page.screencastFrame", {
    data: Buffer.from(content).toString("base64"),
    sessionId: 1,
    metadata: { timestamp },
  });
}

describe("session recordings", () => {
  it("captures independent CDP frames with timestamps, JPEG retrieval, and FPS throttling", async () => {
    const { service, client } = await setup();
    const started = await service.start("s1");
    expect(client.send).toHaveBeenCalledWith(
      "Page.startScreencast",
      { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 2560 },
      { timeout: 3000 },
    );
    frame(client, "jpeg-one", (Date.parse(started.startedAt) + 250) / 1000);
    frame(client, "dropped-too-fast");
    const frames = await service.frames("s1");
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ seq: 1, t: 250, pageId: "page-1", bytes: 8 });
    expect((await service.image("s1", 1)).toString()).toBe("jpeg-one");
    expect(
      client.send.mock.calls.filter(([method]) => method === "Page.screencastFrameAck"),
    ).toHaveLength(2);
    expect(await service.stop("s1")).toMatchObject({
      status: "stopped",
      frames: 1,
      bytes: 8,
      stopReason: "manual",
    });
    expect(client.detach).toHaveBeenCalledOnce();
  });

  it("follows the focused page without needing a viewer socket", async () => {
    const { service, browser, client, page } = await setup();
    await service.start("s1");
    const next = makePage("page-2");
    page.evaluate.mockResolvedValue(false);
    browser.getAllPages.mockResolvedValue([page, next.page]);
    await vi.waitFor(
      () =>
        expect(next.client.send).toHaveBeenCalledWith(
          "Page.startScreencast",
          expect.any(Object),
          expect.any(Object),
        ),
      { timeout: 1500 },
    );
    expect(client.detach).toHaveBeenCalledOnce();
    frame(next.client, "second-page");
    expect((await service.frames("s1"))[0]).toMatchObject({
      pageId: "page-2",
      url: "https://example.test/page-2",
    });
  });

  it("stops before a frame exceeds the session storage cap", async () => {
    const { service, client } = await setup({ maxBytes: 5 });
    await service.start("s1");
    frame(client, "too-large");
    await vi.waitFor(() => expect(service.get("s1").status).toBe("stopped"));
    expect(service.get("s1")).toMatchObject({ frames: 0, bytes: 0, stopReason: "session_limit" });
    expect(await service.frames("s1")).toEqual([]);
  });

  it("enforces the total storage cap across concurrent recordings", async () => {
    const { service, client, sessions, session } = await setup({ totalMaxBytes: 5 });
    const other = makePage("other");
    sessions.set("s2", {
      ...session,
      id: "s2",
      cdpService: { getAllPages: async () => [other.page], getTargetId: () => "other" },
    } as unknown as Session);
    await Promise.all([service.start("s1"), service.start("s2")]);
    frame(client, "four");
    frame(other.client, "more");
    await vi.waitFor(() => expect(service.get("s2").status).toBe("stopped"));
    expect(service.get("s1").bytes).toBe(4);
    expect(service.get("s2")).toMatchObject({ bytes: 0, stopReason: "total_limit" });
  });

  it("keeps replay data after stop, resumes sequence numbers, and deletes all artifacts", async () => {
    const { service, client, store } = await setup();
    await service.start("s1");
    frame(client, "first");
    await service.frames("s1");
    await service.stop("s1", "parked");
    await service.start("s1");
    frame(client, "second");
    expect((await service.frames("s1")).map((item) => item.seq)).toEqual([1, 2]);
    await service.remove("s1");
    expect(service.list()).toEqual([]);
    expect(await store.list("recordings")).toEqual([]);
    expect(() => service.get("s1")).toThrow("Recording not found");
  });

  it("reconciles a manifest committed before metadata during recovery", async () => {
    const { service, store, deps } = await setup();
    await store.write("recordings/recovered/meta.json", {
      sessionId: "recovered",
      status: "recording",
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      frames: 0,
      bytes: 0,
      stopReason: null,
    });
    await store.append("recordings/recovered/manifest.jsonl", {
      seq: 1,
      t: 0,
      at: new Date().toISOString(),
      pageId: "page",
      url: "about:blank",
      bytes: 12,
    });
    const recovered = new RecordingService(deps);
    await recovered.initialize();
    cleanup.push(() => recovered.close());
    expect(recovered.get("recovered")).toMatchObject({
      status: "stopped",
      frames: 1,
      bytes: 12,
      stopReason: "restart",
    });
    expect(service.list()).toEqual([]);
  });

  it("rejects a missing or Selenium session and unsafe storage IDs", async () => {
    const { service, session } = await setup();
    await expect(service.start("missing")).rejects.toMatchObject({ code: "not_live" });
    session.isSelenium = true;
    await expect(service.start("s1")).rejects.toMatchObject({ code: "not_supported" });
    expect(() => service.start("../escape")).toThrow("Invalid session ID");
  });
});
