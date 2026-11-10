import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PlatformStore } from "../platform/store.js";
import { ScorecardService, recommend, signalsOf, type ModeScore } from "./scorecard.js";
import { bumpFingerprintVersion } from "./identity.service.js";

let root: string, store: PlatformStore, clock: number;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "steel-scorecard-"));
  store = new PlatformStore(root);
  clock = Date.parse("2026-11-11T02:00:00Z");
});
afterEach(() => rm(root, { recursive: true, force: true }));

const report = (issues: [string, "error" | "warning"][], values: any = { clientHints: {} }) =>
  ({
    browserVersion: "Chrome/156.0.8078.79",
    issues: issues.map(([code, severity]) => ({ code, severity, message: code })),
    observed: { status: "measured", values },
  }) as any;
const lab = (...failed: string[]) =>
  ({ checks: failed.map((name) => ({ name, status: "fail" })) }) as any;
const service = (over: Partial<ConstructorParameters<typeof ScorecardService>[0]> = {}) => {
  const publish = vi.fn();
  const byMode: Record<string, any> = {
    legacy: report([["browser_version_mismatch", "error"]], { clientHints: null }),
    compatible: report([], { clientHints: {}, graphics: { renderer: "ANGLE (SwiftShader)" } }),
    native: report([["locale_mismatch", "warning"]], {
      clientHints: {},
      userAgent: "HeadlessChrome/156",
    }),
  };
  let current = "";
  const s = new ScorecardService({
    store,
    measure: async (options, fn) => {
      current = options.compatibilityMode!;
      return fn({ id: current } as any);
    },
    inspect: async (id) => byMode[id],
    lab: async () => lab(),
    publish,
    configured: "auto",
    now: () => clock,
    ...over,
  });
  return { s, publish };
};

describe("stealth scorecard", () => {
  it("scores each mode, recommends the best and uses it as the default", async () => {
    const { s, publish } = service();
    expect(await s.defaultMode()).toBe("compatible");
    const card = await s.run("nightly");
    expect(card.modes.map((m) => [m.mode, m.score])).toEqual([
      ["compatible", 95],
      ["native", 90],
      ["legacy", 80],
    ]);
    expect(card.modes[2]).toMatchObject({ errors: ["browser_version_mismatch"], signals: [] });
    expect(card.modes[0].signals).toEqual(["software GPU"]);
    expect(card.recommended).toBe("compatible");
    expect(card.changed).toBe(false);
    expect(publish).toHaveBeenCalledWith(
      "identity.scorecard",
      expect.objectContaining({ recommended: "compatible" }),
    );
    const restarted = service().s;
    expect((await restarted.latest())?.id).toBe(card.id);
    expect(await restarted.defaultMode()).toBe("compatible");
  });

  it("flags a change of recommendation and keeps the old one when nothing was measured", async () => {
    const { s } = service();
    await s.run();
    clock += 86_400_000;
    const flipped = service({
      inspect: async (id) =>
        id === "native" ? report([]) : report([["browser_version_mismatch", "error"]]),
    }).s;
    const next = await flipped.run("nightly");
    expect(next).toMatchObject({ recommended: "native", previous: "compatible", changed: true });
    clock += 86_400_000;
    const busy = service({ measure: async () => undefined }).s;
    const skipped = await busy.run("nightly");
    expect(skipped.recommended).toBeUndefined();
    expect(skipped.modes.every((m) => m.status === "skipped")).toBe(true);
    expect(await busy.defaultMode()).toBe("native");
    expect(await busy.history()).toHaveLength(2);
  });

  it("honours a pinned mode and the legacy opt-out, and knows when a run is due", async () => {
    expect(await service({ configured: "legacy" }).s.defaultMode()).toBeUndefined();
    expect(await service({ configured: undefined }).s.defaultMode()).toBeUndefined();
    expect(await service({ configured: "native" }).s.defaultMode()).toBe("native");
    const { s } = service();
    expect(await s.due()).toBe(true);
    await s.run();
    expect(await s.due()).toBe(false);
    clock += 21 * 3_600_000; // 23:00 UTC the same day
    expect(await s.due()).toBe(false);
    clock += 3 * 3_600_000; // 02:00 UTC
    expect(await s.due()).toBe(true);
  });

  it("breaks ties towards a declared, consistent identity", () => {
    const m = (mode: any, score: number): ModeScore => ({
      mode,
      status: "measured",
      score,
      errors: [],
      warnings: [],
      failedChecks: [],
      signals: [],
    });
    expect(recommend([m("legacy", 90), m("native", 90), m("compatible", 90)])).toBe("compatible");
    expect(recommend([m("legacy", 95), m("native", 90)])).toBe("legacy");
    expect(recommend([])).toBeUndefined();
    expect(signalsOf({ webdriver: true, screen: { width: 800, innerWidth: 1280 } })).toEqual([
      "navigator.webdriver is true",
      "screen smaller than the window",
    ]);
  });
});

describe("pinned fingerprint upkeep", () => {
  const fingerprint = () =>
    ({
      fingerprint: {
        navigator: {
          userAgent:
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
          appVersion: "5.0 (X11; Linux x86_64) Chrome/145.0.0.0 Safari/537.36",
          hardwareConcurrency: 8,
          userAgentData: {
            uaFullVersion: "145.0.7632.6",
            brands: [
              { brand: "Not A;Brand", version: "99" },
              { brand: "Chromium", version: "145" },
            ],
            fullVersionList: [{ brand: "Google Chrome", version: "145.0.7632.6" }],
          },
        },
        screen: { width: 1920 },
      },
      headers: {
        "user-agent": "old",
        "sec-ch-ua": '"Chromium";v="145", "Not A;Brand";v="99"',
        "accept-language": "en-US",
      },
    }) as any;

  it("moves only the version fields to the running Chrome", () => {
    const fp = fingerprint();
    expect(bumpFingerprintVersion(fp, "Chromium 156.0.8078.79")).toBe(true);
    const n = fp.fingerprint.navigator;
    expect(n.userAgent).toContain("Chrome/156.0.0.0");
    expect(n.appVersion).toContain("Chrome/156.0.0.0");
    expect(n.userAgentData).toEqual({
      uaFullVersion: "156.0.8078.79",
      brands: [
        { brand: "Not A;Brand", version: "99" },
        { brand: "Chromium", version: "156" },
      ],
      fullVersionList: [{ brand: "Google Chrome", version: "156.0.8078.79" }],
    });
    expect(fp.headers).toEqual({
      "user-agent": n.userAgent,
      "sec-ch-ua": '"Chromium";v="156", "Not A;Brand";v="99"',
      "accept-language": "en-US",
    });
    expect(n.hardwareConcurrency).toBe(8);
    expect(fp.fingerprint.screen).toEqual({ width: 1920 });
  });

  it("leaves a current fingerprint and an unreadable version alone", () => {
    const fp = fingerprint();
    expect(bumpFingerprintVersion(fp, "Chromium 145.0.7700.1")).toBe(false);
    expect(bumpFingerprintVersion(fp, "unknown")).toBe(false);
    expect(fp).toEqual(fingerprint());
  });
});
