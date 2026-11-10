import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./cdp/cdp.service.js", () => ({ CDPService: class {} }));
import { BrowserPool, PoolClosedError } from "./browser-pool.service.js";

function pool(size = 1) {
  const logger = { child: () => logger, info: vi.fn(), warn: vi.fn() };
  return new BrowserPool(size, 9222, logger as never, () => ({}), false);
}

afterEach(() => vi.useRealTimers());

describe("BrowserPool reservations", () => {
  it("rechecks background capacity at reservation and leaves the final slot for users", async () => {
    const p = pool(2);
    // A background scheduler saw two free slots, then a foreground launch won admission.
    expect(p.allSlots.filter((slot) => slot.state === "free")).toHaveLength(2);
    p.acquire("user-first");
    expect(
      await p.acquireWhenAvailable("background-late", { background: true, timeoutMs: 10_000 }),
    ).toBeNull();
    expect(p.queuedCount).toBe(0);
    expect(p.acquire("user-second")?.sessionId).toBe("user-second");
    p.release("user-first");
    p.release("user-second");
    expect((await p.acquireWhenAvailable("background", { background: true }))?.sessionId).toBe(
      "background",
    );
    expect(await p.acquireWhenAvailable("another-background", { background: true })).toBeNull();
    expect(p.acquire("user-last")?.sessionId).toBe("user-last");
  });

  it("does not let background work bypass a waiting primary-only user", async () => {
    const p = pool(3);
    p.acquire("primary");
    const user = p.acquireWhenAvailable("waiting-user", { primaryOnly: true, timeoutMs: 10_000 });
    expect(p.allSlots.filter((slot) => slot.state === "free")).toHaveLength(2);
    expect(
      await p.acquireWhenAvailable("background", { background: true, timeoutMs: 10_000 }),
    ).toBeNull();
    expect(p.queue.map((entry) => entry.sessionId)).toEqual(["waiting-user"]);
    p.release("primary");
    expect((await user)?.index).toBe(0);
  });

  it("queues for memory and admits FIFO when headroom recovers without a slot release", async () => {
    vi.useFakeTimers();
    const p = pool(2);
    let enoughMemory = false;
    p.setAdmissionGuard(() => enoughMemory);
    expect(p.acquire("immediate")).toBeNull();
    const first = p.acquireWhenAvailable("first", { timeoutMs: 5_000 });
    const second = p.acquireWhenAvailable("second", { timeoutMs: 5_000 });
    expect(p.allSlots.every((slot) => slot.state === "free")).toBe(true);
    expect(p.hasMemoryCapacity()).toBe(false);
    enoughMemory = true;
    expect(p.acquire("jumper")).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect((await first)?.index).toBe(0);
    expect((await second)?.index).toBe(1);
    expect(p.queuedCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("continues to enforce the memory guard on release and clears polling on shutdown", async () => {
    vi.useFakeTimers();
    const p = pool();
    let enoughMemory = true;
    p.setAdmissionGuard(() => enoughMemory);
    p.acquire("busy");
    const next = p.acquireWhenAvailable("next", { timeoutMs: 5_000 });
    enoughMemory = false;
    p.release("busy");
    await vi.advanceTimersByTimeAsync(1000);
    expect(p.primary.state).toBe("free");
    expect(p.queuedCount).toBe(1);
    const rejected = expect(next).rejects.toBeInstanceOf(PoolClosedError);
    p.close();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps starting and stopping slots unavailable until explicitly released", () => {
    const p = pool();
    const slot = p.acquire("first")!;
    expect(slot.state).toBe("starting");
    expect(p.acquire("second")).toBeNull();
    p.markLive("first");
    expect(slot.state).toBe("live");
    p.markStopping("first");
    expect(p.acquire("second")).toBeNull();
    p.release("first");
    expect(p.acquire("second")?.sessionId).toBe("second");
  });

  it("serves waiters FIFO and prevents immediate requests jumping the queue", async () => {
    const p = pool(2);
    p.acquire("primary");
    p.acquire("secondary");
    const first = p.acquireWhenAvailable("first", { primaryOnly: true, timeoutMs: 1000 });
    const second = p.acquireWhenAvailable("second", { timeoutMs: 1000 });
    p.release("secondary");
    expect(p.acquire("jumper")).toBeNull();
    expect(p.queue.map((r) => r.sessionId)).toEqual(["first", "second"]);
    p.release("primary");
    expect((await first)?.index).toBe(0);
    expect((await second)?.index).toBe(1);
    expect(p.queuedCount).toBe(0);
  });

  it("removes timed-out waiters without reserving the next released slot", async () => {
    vi.useFakeTimers();
    const p = pool();
    p.acquire("busy");
    const waiting = p.acquireWhenAvailable("expired", { timeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(25);
    expect(await waiting).toBeNull();
    expect(p.queuedCount).toBe(0);
    p.release("busy");
    expect(p.acquire("next")?.sessionId).toBe("next");
  });

  it("cancels a disconnected waiter and advances the remaining queue", async () => {
    const p = pool(2);
    p.acquire("primary");
    p.acquire("secondary");
    const abort = new AbortController();
    const cancelled = p.acquireWhenAvailable("cancelled", {
      primaryOnly: true,
      timeoutMs: 1000,
      signal: abort.signal,
    });
    const rejected = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    const next = p.acquireWhenAvailable("next", { timeoutMs: 1000 });
    p.release("secondary");
    abort.abort();
    await rejected;
    expect((await next)?.index).toBe(1);
    expect(p.queuedCount).toBe(0);
  });

  it("does not acquire for a signal that is already cancelled", async () => {
    const p = pool();
    await expect(
      p.acquireWhenAvailable("cancelled", { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(p.primary.state).toBe("free");
  });

  it("rejects queued and new requests when shutting down", async () => {
    const p = pool();
    p.acquire("busy");
    const waiting = p.acquireWhenAvailable("waiting", { timeoutMs: 1000 });
    const rejected = expect(waiting).rejects.toBeInstanceOf(PoolClosedError);
    p.close();
    await rejected;
    p.release("busy");
    expect(p.queuedCount).toBe(0);
    expect(() => p.acquire("new")).toThrow(PoolClosedError);
  });
});

describe("BrowserPool.allocatePorts", () => {
  it("skips the reserved nginx port after the primary", () => {
    expect(BrowserPool.allocatePorts(4, 9222, [9223])).toEqual([9222, 9224, 9225, 9226]);
  });

  it("keeps the base port for a single slot", () => {
    expect(BrowserPool.allocatePorts(1, 9222, [9223])).toEqual([9222]);
  });

  it("uses consecutive ports when nothing is reserved", () => {
    expect(BrowserPool.allocatePorts(3, 9300)).toEqual([9300, 9301, 9302]);
  });
});
