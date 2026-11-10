import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PlatformStore } from "../platform/store.js";
import { DoctorService } from "./doctor.service.js";
import { diagnosticBrowserEpoch } from "../fleet/diagnostic-evidence.js";
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
    expect(report.observations.map((o) => [o.component, o.status])).toEqual(
      expect.arrayContaining([
        ["cdp", "fail"],
        ["renderer", "fail"],
      ]),
    );
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

describe("current browser-origin network evidence", () => {
  const host = () => {
    let endpoint = "ws://127.0.0.1/devtools/browser/current";
    const browser = {
      connected: true,
      wsEndpoint: () => endpoint,
      version: async () => "Chrome",
      pages: async () => [
        { url: () => "about:blank", evaluate: async () => ({ ready: "complete" }) },
      ],
    };
    const session = {
      id: "s",
      status: "live",
      cdpService: { getBrowserInstance: () => browser },
    } as any;
    return {
      session,
      restart: () => {
        endpoint += "-restarted";
      },
      service: new DoctorService(store, {
        getSession: () => session,
        getLaunchOptions: () => ({ proxyUrl: "http://user:proxy-secret@proxy.test" }),
      } as any),
    };
  };
  const evidence = (session: any, overrides = {}) => ({
    id: "probe",
    sessionId: "s",
    checkedAt: new Date().toISOString(),
    browserEpoch: diagnosticBrowserEpoch(session),
    collectorOrigin: "https://collector.test/?token=collector-secret",
    limits: [],
    probes: [
      {
        channel: "http",
        status: "pass",
        reason: "unsafe raw-secret",
        observedIp: "192.0.2.20",
        headers: { authorization: "secret" },
      },
      {
        channel: "dns",
        status: "pass",
        reason: "unsafe raw-secret",
        observations: [{ resolverIp: "192.0.2.21" }],
      },
    ],
    ...overrides,
  });
  it("uses recent exact-browser HTTP and authoritative DNS evidence without copying sensitive fields", async () => {
    const { session, service } = host();
    await store.write("egress-diagnostics/s.json", evidence(session));
    const report = await service.diagnose("s", actor);
    for (const component of ["network_http", "dns", "proxy"])
      expect(report.observations).toContainEqual(
        expect.objectContaining({ component, status: "pass", observedAt: expect.any(String) }),
      );
    expect(JSON.stringify(report)).not.toMatch(
      /secret|192\.0\.2|collector\.test|proxy\.test|browserEpoch/,
    );
  });
  it.each(["old", "future", "different-session", "different-launch", "legacy"])(
    "rejects %s measurement without claiming an outage",
    async (kind) => {
      const { session, service, restart } = host();
      const saved = evidence(session);
      if (kind === "old") saved.checkedAt = new Date(Date.now() - 121000).toISOString();
      if (kind === "future") saved.checkedAt = new Date(Date.now() + 10000).toISOString();
      if (kind === "different-session") saved.sessionId = "other";
      if (kind === "different-launch") restart();
      if (kind === "legacy") delete saved.browserEpoch;
      await store.write("egress-diagnostics/s.json", saved);
      const report = await service.diagnose("s", actor);
      expect(
        report.observations
          .filter((o) => ["network_http", "dns", "proxy"].includes(o.component))
          .every((o) => o.status === "untested"),
      ).toBe(true);
      expect(report.recovery).toContainEqual(
        expect.objectContaining({ action: "run_egress_diagnostics", automatic: false }),
      );
    },
  );
  it("does not misattribute a collector HTTP failure to the configured proxy", async () => {
    const { session, service } = host();
    await store.write(
      "egress-diagnostics/s.json",
      evidence(session, { probes: [{ channel: "http", status: "fail", reason: "token=secret" }] }),
    );
    const report = await service.diagnose("s", actor);
    expect(report.observations).toContainEqual(
      expect.objectContaining({ component: "network_http", status: "fail" }),
    );
    expect(report.observations).toContainEqual(
      expect.objectContaining({ component: "proxy", status: "untested" }),
    );
  });
  it("bounds an unavailable evidence store without starting a browser probe", async () => {
    vi.useFakeTimers();
    const { service } = host();
    vi.spyOn(store, "read").mockImplementation(() => new Promise(() => {}));
    const pending = service.diagnose("s", actor);
    await vi.advanceTimersByTimeAsync(2100);
    const report = await pending;
    expect(report.observations).toContainEqual(
      expect.objectContaining({ component: "proxy", status: "untested" }),
    );
    expect(report.recovery).toContainEqual(
      expect.objectContaining({ action: "run_egress_diagnostics", automatic: false }),
    );
  });
  it.each([
    ["proxy_connection_failed", "proxy"],
    ["proxy_tunnel_failed", "proxy"],
    ["proxy_authentication_required", "proxy"],
    ["name_resolution_failed", "dns"],
  ])("classifies the measured browser failure %s", async (failure, component) => {
    const { session, service } = host();
    await store.write(
      "egress-diagnostics/s.json",
      evidence(session, {
        navigationFailure: failure,
        probes: [{ channel: "http", status: "fail" }],
      }),
    );
    const report = await service.diagnose("s", actor);
    expect(report.observations).toContainEqual(
      expect.objectContaining({ component, status: "fail", confidence: "high" }),
    );
  });
});
