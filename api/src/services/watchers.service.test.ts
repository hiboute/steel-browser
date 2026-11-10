import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WatcherService, matchesCondition, withinActiveHours } from "./watchers.service.js";
import { WatcherSettings } from "../modules/extras/extras.schema.js";
import { PlatformStore } from "./platform/store.js";
import { boundedRegex } from "./watchers-regex.js";
import { ExtrasError } from "./extract.service.js";

vi.mock("../utils/scrape/safeGoTo.js", () => ({ safeGoto: vi.fn().mockResolvedValue({}) }));
vi.mock("./navigation-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./navigation-policy.js")>()),
  assertAllowedUrl: vi.fn(async (url) => url),
  withNavigationPolicy: vi.fn(async (_page, run) =>
    run({ assertUrl: async (url) => url, throwIfBlocked: () => {} }),
  ),
}));
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "steel-watcher-test-"));
  directories.push(root);
  const store = new PlatformStore(root, "test-encryption-key");
  const page = { waitForSelector: vi.fn(), $eval: vi.fn().mockResolvedValue("10") };
  const jobs = {
    run: vi.fn(async (_kind, _options, fn) =>
      fn({ cdpService: { getPrimaryPage: async () => page } }),
    ),
  };
  const notifier = { send: vi.fn().mockResolvedValue({}) };
  const events = { publish: vi.fn() };
  const service = new WatcherService(
    store,
    jobs,
    {} as never,
    events as never,
    notifier as never,
    { warn: vi.fn(), error: vi.fn() } as never,
  );
  const settings = WatcherSettings.parse({
    name: "Price",
    url: "https://example.com",
    extract: { selector: "#price" },
    condition: { type: "changed" },
    notify: { cooldownMinutes: 0 },
  });
  return { service, page, jobs, notifier, events, store, settings };
}

describe("page watchers", () => {
  it("compares successive values, notifies on changes, and persists its state and history", async () => {
    const { service, page, notifier, store, settings, jobs } = await setup();
    const watcher = await service.create(settings, "mcp:owner@example.com");
    expect((await service.run(watcher.id)).matched).toBe(false);
    page.$eval.mockResolvedValue("12");
    expect((await service.run(watcher.id)).matched).toBe(true);
    expect(notifier.send).toHaveBeenCalledOnce();
    expect(jobs.run.mock.calls[0][1].sessionOptions.client).toBe("mcp:owner@example.com");
    expect(await service.history(watcher.id)).toHaveLength(2);
    expect((await store.read<any>(`watchers/${watcher.id}.json`)).state.lastValue).toBe("12");
  });
  it("postpones when no background slot is available without overwriting the baseline", async () => {
    const { service, jobs, settings } = await setup();
    const watcher = await service.create(settings);
    await service.run(watcher.id);
    jobs.run.mockResolvedValueOnce(undefined);
    expect((await service.run(watcher.id)).status).toBe("postponed");
    expect(service.get(watcher.id).state.lastValue).toBe("10");
    expect(await service.history(watcher.id)).toHaveLength(1);
  });
  it("shares concurrent runs and never resurrects a watcher deleted while running", async () => {
    const { service, jobs, settings, store } = await setup();
    const watcher = await service.create(settings);
    const gate = Promise.withResolvers<{ value: string }>();
    jobs.run.mockReturnValue(gate.promise);
    const one = service.run(watcher.id);
    expect(service.run(watcher.id)).toBe(one);
    await service.remove(watcher.id);
    gate.resolve({ value: "12" });
    await one;
    expect(await store.read(`watchers/${watcher.id}.json`)).toBeUndefined();
  });
  it("reports repeated errors only after the threshold and keeps only 50 runs", async () => {
    const { service, jobs, notifier, settings } = await setup();
    const watcher = await service.create(settings);
    jobs.run.mockRejectedValue(
      new ExtrasError("blocked_target", "Private destination blocked", 400),
    );
    for (let i = 0; i < 2; i++) await service.run(watcher.id);
    expect(notifier.send).not.toHaveBeenCalled();
    await service.run(watcher.id);
    expect(notifier.send).toHaveBeenCalledOnce();
    expect((await service.history(watcher.id)).at(-1)).toMatchObject({
      code: "blocked_target",
      statusCode: 400,
    });
    jobs.run.mockResolvedValue({ value: "12" });
    for (let i = 0; i < 50; i++) await service.run(watcher.id);
    expect(await service.history(watcher.id)).toHaveLength(50);
    expect(service.get(watcher.id).state.consecutiveErrors).toBe(0);
  });
  it.each(["delete", "update"] as const)(
    "serializes %s against a completion already reading history",
    async (operation) => {
      const { service, store, settings } = await setup();
      const watcher = await service.create(settings);
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const original = store.readLines.bind(store);
      vi.spyOn(store, "readLines").mockImplementationOnce(async (filename) => {
        entered.resolve();
        await resume.promise;
        return original(filename);
      });
      const running = service.run(watcher.id);
      await entered.promise;
      const mutation =
        operation === "delete"
          ? service.remove(watcher.id)
          : service.update(watcher.id, { ...settings, name: "Edited after run" });
      resume.resolve();
      await Promise.all([running, mutation]);
      const persisted = await store.read<any>(`watchers/${watcher.id}.json`);
      if (operation === "delete") {
        expect(persisted).toBeUndefined();
        expect(await original(`watchers/${watcher.id}.history.jsonl`)).toEqual([]);
      } else expect(persisted.name).toBe("Edited after run");
    },
  );
  it("terminates pathological regex without blocking the API event loop", async () => {
    let responsive = false;
    const timer = setTimeout(() => {
      responsive = true;
    }, 20);
    await expect(boundedRegex("(a+)+$", "a".repeat(30000) + "!", 150)).rejects.toThrow(
      "execution limit",
    );
    clearTimeout(timer);
    expect(responsive).toBe(true);
  });
  it("supports overnight schedules and numeric/string conditions", async () => {
    const hours = { start: 22, end: 6, timezone: "UTC" };
    expect(withinActiveHours(hours, new Date("2026-01-01T23:00:00Z"))).toBe(true);
    expect(withinActiveHours(hours, new Date("2026-01-01T06:00:00Z"))).toBe(false);
    expect(await matchesCondition({ type: "lt", value: 20 }, "10", undefined)).toBe(true);
    expect(await matchesCondition({ type: "gt", value: 20 }, "NaN", undefined)).toBe(false);
    expect(
      await matchesCondition({ type: "matches", value: "stock: [1-9]" }, "stock: 5", undefined),
    ).toBe(true);
  });
});
