import { describe, expect, it, vi } from "vitest";

import { DuckDBStorage } from "./duckdb-storage.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function bufferedEvent(timestamp: string) {
  return {
    event: { type: "Console", timestamp, message: "test" },
    context: {},
  };
}

describe("DuckDBStorage flush barrier", () => {
  it("waits for an active flush and drains events appended while it runs", async () => {
    const firstFlush = deferred();
    const storage = new DuckDBStorage();
    const internals = storage as any;
    internals.db = {};
    internals.writeBuffer = [bufferedEvent("2026-07-23T00:00:00.000Z")];
    internals.writeBatchInternal = vi
      .fn()
      .mockImplementationOnce(async () => firstFlush.promise)
      .mockResolvedValueOnce(undefined);

    const firstBarrier = storage.flush();
    await Promise.resolve();
    internals.writeBuffer.push(bufferedEvent("2026-07-23T00:00:01.000Z"));
    const secondBarrier = storage.flush();

    firstFlush.resolve();
    await Promise.all([firstBarrier, secondBarrier]);

    expect(internals.writeBatchInternal).toHaveBeenCalledTimes(2);
    expect(internals.writeBuffer).toEqual([]);
    expect(internals.flushPromise).toBeNull();
  });

  it("waits for an in-flight flush before closing the database", async () => {
    const firstFlush = deferred();
    const storage = new DuckDBStorage();
    const internals = storage as any;
    const closeDatabase = vi.fn().mockResolvedValue(undefined);
    internals.db = { close: closeDatabase };
    internals.writeBuffer = [bufferedEvent("2026-07-23T00:00:00.000Z")];
    internals.writeBatchInternal = vi.fn().mockImplementationOnce(async () => firstFlush.promise);

    const flushing = storage.flush();
    await Promise.resolve();
    const closing = storage.close();

    // The database must stay open until the write in flight has landed.
    expect(closeDatabase).not.toHaveBeenCalled();

    firstFlush.resolve();
    await Promise.all([flushing, closing]);

    expect(closeDatabase).toHaveBeenCalledTimes(1);
    expect(internals.writeBuffer).toEqual([]);
  });
});
