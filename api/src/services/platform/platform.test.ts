import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlatformStore } from "./store.js";
import { MemoryGuard } from "./memory.js";
import { Metrics } from "./metrics.js";
import { PlatformEvents } from "./events.js";
import { Notifier } from "./notifier.js";
import { AuditLog } from "./audit.js";
import { BackgroundJobs } from "./jobs.js";
import { SessionPoolFullError } from "../session.service.js";

const directories: string[] = [];
async function temporary() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "steel-platform-"));
  directories.push(dir);
  return dir;
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("durable platform storage", () => {
  it("uses authenticated encryption for JSON and JSONL and supports plaintext migration", async () => {
    const dir = await temporary();
    const plain = new PlatformStore(dir);
    await plain.write("plain.json", { cookies: "legacy-secret" });
    const store = new PlatformStore(dir, "test-key");
    expect(await store.read("plain.json")).toEqual({ cookies: "legacy-secret" });
    await store.write("parked/session/meta.json", { cookies: "login-secret" });
    await Promise.all(
      Array.from({ length: 20 }, (_, seq) => store.append("audit/events.jsonl", { seq })),
    );
    expect(await store.readLines("audit/events.jsonl")).toEqual(
      Array.from({ length: 20 }, (_, seq) => ({ seq })),
    );
    expect(await readFile(store.path("parked/session/meta.json"), "utf8")).not.toContain(
      "login-secret",
    );
    expect(await store.read("parked/session/meta.json")).toEqual({ cookies: "login-secret" });
    await expect(
      new PlatformStore(dir, "wrong-key").read("parked/session/meta.json"),
    ).rejects.toThrow();
    expect(() => store.path("../outside")).toThrow("escapes");
    expect(() => store.remove(".")).toThrow("data root");
  });

  it("ignores only an incomplete final JSONL append and retains previous complete records", async () => {
    const store = new PlatformStore(await temporary());
    await writeFile(store.path("events.jsonl"), '{"ok":1}\n{"partial":');
    expect(await store.readLines("events.jsonl")).toEqual([{ ok: 1 }]);
    await store.append("events.jsonl", { ok: 2 });
    expect(await store.readLines("events.jsonl")).toEqual([{ ok: 1 }, { ok: 2 }]);
    await writeFile(store.path("events.jsonl"), '{"ok":1}\nbroken\n');
    await expect(store.readLines("events.jsonl")).rejects.toThrow();
  });

  it("filters audit pagination and drops expired months", async () => {
    const store = new PlatformStore(await temporary());
    const audit = new AuditLog(store, 10);
    await store.append("audit/2000-01.jsonl", { at: "2000-01-01T00:00:00.000Z", event: "old" });
    await audit.log("cookieset.loaded", { client: "mcp:person", subject: "mail" });
    await audit.log("cookieset.read", { subject: "bank" });
    expect(await audit.list({ event: "cookieset.loaded" })).toMatchObject([
      { client: "mcp:person", subject: "mail" },
    ]);
    expect(await audit.list({ before: "2000-01-01T00:00:00.000Z" })).toEqual([]);
    await audit.sweep();
    expect(await store.list("audit")).not.toContain("2000-01.jsonl");
  });
});

describe("memory guard", () => {
  it("uses the smaller cgroup headroom and sums only each Chrome process tree", async () => {
    const dir = await temporary();
    const proc = path.join(dir, "proc");
    const cgroup = path.join(dir, "cgroup");
    await mkdir(proc);
    await mkdir(cgroup);
    await writeFile(path.join(proc, "meminfo"), "MemTotal: 8192 kB\nMemAvailable: 4096 kB\n");
    await writeFile(path.join(cgroup, "memory.max"), String(2048 * 1024));
    await writeFile(path.join(cgroup, "memory.current"), String(1800 * 1024));
    for (const [pid, parent, rss] of [
      [10, 1, 100],
      [11, 10, 200],
      [12, 11, 50],
      [20, 1, 999],
    ]) {
      await mkdir(path.join(proc, String(pid)));
      await writeFile(
        path.join(proc, String(pid), "status"),
        `PPid: ${parent}\nVmRSS: ${rss} kB\n`,
      );
    }
    const memory = new MemoryGuard(300 * 1024, proc, cgroup);
    expect(memory.snapshot([10])).toMatchObject({
      availableBytes: 248 * 1024,
      limitBytes: 2048 * 1024,
      chromeRssBytes: 350 * 1024,
      pressure: true,
    });
    expect(memory.hasCapacity()).toBe(false);
    expect(new MemoryGuard(0, proc, cgroup).hasCapacity()).toBe(true);
  });

  it("treats cgroup max as unlimited and honors MemAvailable", async () => {
    const dir = await temporary();
    await writeFile(path.join(dir, "meminfo"), "MemTotal: 8192 kB\nMemAvailable: 4096 kB\n");
    await writeFile(path.join(dir, "memory.max"), "max");
    const memory = new MemoryGuard(1024, dir, dir);
    expect(memory.snapshot()).toMatchObject({
      availableBytes: 4096 * 1024,
      limitBytes: null,
      pressure: false,
    });
  });
});

describe("notifications and telemetry", () => {
  it("persists before delivery, retries failures twice, and constructs viewer links", async () => {
    const store = new PlatformStore(await temporary(), "notification-key");
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(new Response("error", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const events = new PlatformEvents();
    const seen: unknown[] = [];
    events.subscribe((event) => seen.push(event));
    const notifier = new Notifier(
      store,
      events,
      { warn: vi.fn() } as never,
      "https://example.invalid/hook",
      "https://steel.example/",
    );
    const result = await notifier.send({
      event: "handoff.waiting",
      severity: "warning",
      title: "Help needed",
      message: "2FA needed",
      sessionId: "abc",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ delivered: true, url: "https://steel.example/?session=abc" });
    expect(await notifier.list()).toMatchObject([{ message: "2FA needed", delivered: true }]);
    expect(seen).toHaveLength(1);
    expect(await readFile(store.path("notifications.jsonl"), "utf8")).not.toContain("2FA needed");
  });

  it("keeps only the latest 200 notifications across restarts", async () => {
    const store = new PlatformStore(await temporary());
    await store.rewriteLines(
      "notifications.jsonl",
      Array.from({ length: 200 }, (_, i) => ({ id: String(i) })),
    );
    const notifier = new Notifier(store, new PlatformEvents(), { warn: vi.fn() } as never);
    const newest = await notifier.send({
      event: "test",
      severity: "info",
      title: "New",
      message: "New",
    });
    const listed = await new Notifier(store, new PlatformEvents(), {
      warn: vi.fn(),
    } as never).list();
    expect(listed).toHaveLength(200);
    expect(listed[0].id).toBe(newest.id);
    expect(listed.at(-1)?.id).toBe("1");
  });

  it("escapes metric label values and isolates faulty event subscribers", () => {
    const metrics = new Metrics();
    metrics.increment("steel_reaped_total", { reason: 'a"\nb\\c' });
    metrics.increment("steel_reaped_total", { reason: 'a"\nb\\c' }, 2);
    expect(metrics.render()).toContain('steel_reaped_total{reason="a\\"\\nb\\\\c"} 3');
    expect(() => metrics.gauge("bad-metric", 1)).toThrow();
    const events = new PlatformEvents();
    events.subscribe(() => {
      throw new Error("broken observer");
    });
    const observer = vi.fn();
    const unsubscribe = events.subscribe(observer);
    events.publish("session.started", {}, "session-id");
    expect(observer).toHaveBeenCalledOnce();
    unsubscribe();
    events.publish("session.ended", {});
    expect(observer).toHaveBeenCalledOnce();
  });
});

describe("background admission", () => {
  function setup() {
    const session = { id: "background" };
    const release = vi.fn();
    const service = {
      getPoolStatus: vi.fn(() => ({ queued: 0, free: 3 })),
      startSession: vi.fn(async () => session),
      getSession: vi.fn(() => session),
      holdActivity: vi.fn(() => release),
      endSession: vi.fn(async () => session),
    };
    return { service, release, jobs: new BackgroundJobs(service as never, 1) };
  }
  it("reserves capacity synchronously and never queues behind foreground requests", async () => {
    const { jobs, service } = setup();
    const gate = Promise.withResolvers<void>();
    const one = jobs.run("check", {}, async () => {
      await gate.promise;
      return 1;
    });
    expect(await jobs.run("check", {}, async () => 2)).toBeUndefined();
    gate.resolve();
    expect(await one).toBe(1);
    expect(service.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        queueTimeout: 0,
        keepAlive: true,
        labels: { background: "check" },
      }),
    );
    service.getPoolStatus.mockReturnValue({ queued: 1, free: 3 });
    expect(await jobs.run("check", {}, async () => 3)).toBeUndefined();
    service.getPoolStatus.mockReturnValue({ queued: 0, free: 1 });
    expect(await jobs.run("check", {}, async () => 3)).toBeUndefined();
    expect(service.startSession).toHaveBeenCalledOnce();
  });
  it("releases timed-out job sessions and clears activity holds", async () => {
    vi.useFakeTimers();
    const { jobs, service, release } = setup();
    const work = jobs.run("watcher", { timeoutMs: 1000 }, () => new Promise(() => {}));
    const rejected = expect(work).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(service.endSession).toHaveBeenCalledWith("background");
    expect(release).toHaveBeenCalledOnce();
    expect(jobs.running).toBe(0);
  });
  it("postpones a background run when foreground admission wins during launch hooks", async () => {
    const { jobs, service } = setup();
    service.startSession.mockRejectedValue(new SessionPoolFullError(2));
    const run = vi.fn();
    expect(await jobs.run("watcher", {}, run)).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    expect(jobs.running).toBe(0);
  });
  it("aborts in-progress background work promptly on shutdown", async () => {
    const { jobs, service } = setup();
    const started = Promise.withResolvers<void>();
    const work = jobs.run("watcher", {}, async () => {
      started.resolve();
      return new Promise(() => {});
    });
    const rejected = expect(work).rejects.toThrow("shutting down");
    await started.promise;
    await jobs.close();
    await rejected;
    expect(service.endSession).toHaveBeenCalledOnce();
    expect(await jobs.run("watcher", {}, async () => 1)).toBeUndefined();
  });
});
