import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PlatformStore } from "../platform/store.js";
import { OwnershipService } from "../control/ownership.js";
import { StorageService } from "./storage.service.js";

let root: string, outside: string, store: PlatformStore;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "steel-storage-"));
  outside = await mkdtemp(path.join(os.tmpdir(), "steel-logs-"));
  store = new PlatformStore(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});
const old = new Date(Date.now() - 40 * 86_400_000);

it("reports usage by kind with the retention that applies", async () => {
  await mkdir(path.join(root, "timeline", "s1"), { recursive: true });
  await writeFile(path.join(root, "timeline", "s1", "1.jpg"), Buffer.alloc(2000));
  await writeFile(path.join(root, "events.jsonl"), "x".repeat(100));
  await writeFile(path.join(outside, "logs.db"), Buffer.alloc(5000));
  const storage = new StorageService({
    store,
    activeIds: () => new Set(),
    env: { TIMELINE_RETENTION_DAYS: "3" },
    external: { logs: { label: "Browser logs", path: outside, retention: "Kept until deleted" } },
  });
  const report = await storage.report();
  expect(report.totalBytes).toBe(7100);
  expect(report.kinds.map((kind) => [kind.key, kind.bytes, kind.items])).toEqual([
    ["logs", 5000, 1],
    ["timeline", 2000, 1],
    ["events", 100, 1],
  ]);
  expect(report.kinds[1]).toMatchObject({
    label: "Action timelines",
    retention: "3 days after the last action",
  });
});

it("prunes old reports and ownership records but keeps active browsers and named resources", async () => {
  const live = "11111111-1111-4111-8111-111111111111",
    gone = "22222222-2222-4222-8222-222222222222",
    recent = "33333333-3333-4333-8333-333333333333";
  await store.write("diagnostics/old.json", { id: "old" });
  await store.write("diagnostics/new.json", { id: "new" });
  await store.write(`egress-diagnostics/${live}.json`, {});
  await store.write(`egress-diagnostics/${gone}.json`, {});
  for (const file of [
    "diagnostics/old.json",
    `egress-diagnostics/${live}.json`,
    `egress-diagnostics/${gone}.json`,
  ])
    await utimes(store.path(file), old, old);
  await store.write("control/resources.json", {
    [live]: { ownerId: "a", generation: 1, seenAt: old.toISOString() },
    [gone]: { ownerId: "a", generation: 1, seenAt: old.toISOString() },
    [recent]: { ownerId: "a", generation: 1, seenAt: new Date().toISOString() },
    "browser-profile:shop": { ownerId: "a", generation: 1, seenAt: old.toISOString() },
  });
  const control = new OwnershipService(store);
  await control.initialize();
  const storage = new StorageService({
    store,
    activeIds: () => new Set([live]),
    sweeps: { control: () => control.prune(new Set([live]), storage.controlDays) },
  });
  const result = await storage.prune();
  expect(result.removed).toEqual({ diagnostics: 1, "egress-diagnostics": 1, control: 1 });
  expect(await store.list("diagnostics")).toEqual(["new.json"]);
  expect(await store.list("egress-diagnostics")).toEqual([`${live}.json`]);
  expect(control.readers(gone)).toEqual([]);
  for (const id of [live, recent, "browser-profile:shop"])
    expect(control.readers(id)).toEqual(["a"]);
  expect((await storage.report()).lastPrune).toEqual(result);
  await control.close();
});
