import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PlatformStore } from "../platform/store.js";
import { DoctorService } from "./doctor.service.js";
const actor = { id: "agent", role: "agent" as const, authenticated: true };
let root: string, store: PlatformStore;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "steel-doctor-"));
  store = new PlatformStore(root);
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});
describe("bounded browser failure diagnosis", () => {
  it("separates auth/application/proxy evidence without persisting page or route secrets", async () => {
    const browser = {
      connected: true,
      version: async () => "version",
      pages: async () => [
        {
          url: () => "https://name:secret@owned.test/?token=secret",
          evaluate: async () => ({
            ready: "complete",
            password: true,
            auth: false,
            error: true,
            offline: false,
          }),
        },
      ],
    };
    const service = new DoctorService(store, {
      getSession: () => ({ status: "live", cdpService: { getBrowserInstance: () => browser } }),
      getLaunchOptions: () => ({ proxyUrl: "http://user:password@proxy.test:80" }),
    } as any);
    const report = await service.diagnose("s", actor);
    expect(report.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          component: "authentication",
          status: "fail",
          confidence: "medium",
        }),
        expect.objectContaining({ component: "application", status: "fail" }),
        expect.objectContaining({ component: "proxy", status: "untested" }),
      ]),
    );
    expect(JSON.stringify(report)).not.toMatch(/secret|password@|token=/);
    expect(await service.get(report.id, actor)).toEqual(report);
    await expect(service.get(report.id, { ...actor, id: "stranger" })).rejects.toMatchObject({
      code: "diagnosis_denied",
    });
  });
  it("bounds a stalled browser and renderer and proposes only explicit recovery", async () => {
    vi.useFakeTimers();
    const never = () => new Promise(() => {});
    const browser = { connected: true, version: never, pages: never };
    const service = new DoctorService(store, {
      getSession: () => ({ status: "live", cdpService: { getBrowserInstance: () => browser } }),
    } as any);
    const pending = service.diagnose("s", actor);
    await vi.advanceTimersByTimeAsync(4100);
    const report = await pending;
    expect(report.observations.map((o) => [o.component, o.status])).toEqual([
      ["cdp", "fail"],
      ["renderer", "fail"],
    ]);
    expect(report.recovery.every((r) => r.automatic === false)).toBe(true);
  });
  it("reports parked sessions as untested rather than falsely broken", async () => {
    const service = new DoctorService(store, { getSession: () => ({ status: "parked" }) } as any);
    expect((await service.diagnose("s", actor)).observations[0]).toMatchObject({
      component: "browser",
      status: "untested",
    });
  });
});
