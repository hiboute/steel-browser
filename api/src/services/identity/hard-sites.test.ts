import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { PlatformStore } from "../platform/store.js";
import { HardSites, desktopWorker } from "./hard-sites.js";

let dir: string, store: PlatformStore, clock: number;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "steel-hard-sites-"));
  store = new PlatformStore(dir);
  clock = Date.parse("2026-11-10T12:00:00Z");
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const worker = (over: any = {}) => ({
  id: "w1",
  label: "Mac mini",
  location: "home",
  healthy: true,
  draining: false,
  activeSessions: 0,
  ...over,
  capabilities: {
    engines: ["chromium", "safari"],
    commands: ["launch", "goto"],
    capacity: 1,
    ...over.capabilities,
    device: { kind: "desktop", graphics: "native", headless: false, ...over.device },
  },
});
const sites = (workers: any[] = []) =>
  new HardSites({ store, workers: () => workers, now: () => clock });

it("counts only blocks, calls a site hard after two and survives a restart", async () => {
  const s = sites();
  await s.record("https://shop.example", "two_factor");
  await s.record("about:blank", "captcha");
  expect(await s.list()).toEqual([]);
  await s.record("https://shop.example", "captcha");
  expect((await s.advice("https://shop.example/cart")).hard).toBe(false);
  await s.record("https://shop.example", "access_denied");
  const restarted = sites();
  expect(await restarted.list()).toMatchObject([
    {
      origin: "https://shop.example",
      hits: 2,
      hard: true,
      kinds: { captcha: 1, access_denied: 1 },
    },
  ]);
  expect(await restarted.advice("https://other.example/")).toMatchObject({ hard: false, hits: 0 });
  expect(await restarted.advice("not a url")).toMatchObject({ hard: false });
});

it("points a hard site at a free real desktop and says so when there is none", async () => {
  const none = sites();
  await none.record("https://shop.example", "captcha");
  await none.record("https://shop.example", "captcha");
  const alone = await none.advice("https://shop.example/");
  expect(alone.desktop).toBeUndefined();
  expect(alone.suggestion).toContain("no real desktop worker is online");
  const advice = await sites([worker()]).advice("https://shop.example/");
  expect(advice.desktop).toEqual({
    id: "w1",
    label: "Mac mini",
    location: "home",
    engines: ["chromium", "safari"],
  });
  expect(advice.suggestion).toContain('"Mac mini"');
});

it("accepts only an online, native, headed desktop with room", () => {
  expect(desktopWorker([worker({ healthy: false })])).toBeUndefined();
  expect(desktopWorker([worker({ draining: true })])).toBeUndefined();
  expect(desktopWorker([worker({ activeSessions: 1 })])).toBeUndefined();
  expect(desktopWorker([worker({ device: { graphics: "software" } })])).toBeUndefined();
  expect(desktopWorker([worker({ device: { headless: true } })])).toBeUndefined();
  expect(desktopWorker([worker({ device: { kind: "android" } })])).toBeUndefined();
  expect(
    desktopWorker([
      worker({ id: "busy", activeSessions: 1, capabilities: { capacity: 2 } }),
      worker({ id: "free" }),
    ])?.id,
  ).toBe("free");
});

it("forgets a site on request and on its own after thirty quiet days", async () => {
  const s = sites();
  await s.record("https://a.example", "captcha");
  await s.record("https://b.example", "captcha");
  expect(await s.forget("https://a.example")).toBe(true);
  expect(await s.forget("https://a.example")).toBe(false);
  clock += 31 * 86_400_000;
  expect(await s.list()).toEqual([]);
});
