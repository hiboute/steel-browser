import { expect, it, vi } from "vitest";
import { FingerprintInjector } from "fingerprint-injector";
import { CDPService } from "../cdp/cdp.service.js";

function host(mode: string) {
  return Object.assign(Object.create(CDPService.prototype), {
    launchConfig: { compatibilityMode: mode },
    compatibilityFallbacks: new Set(),
    logger: { error: vi.fn(), debug: vi.fn() },
    buildUserAgentOverride: () => ({
      isMobile: false,
      navigatorPlatform: "Linux x86_64",
      uaPlatform: "Linux",
      override: { userAgent: "Chrome/149.0.0.0", userAgentMetadata: {} },
    }),
    withEmulationSession: vi.fn(async () => {
      throw new Error("CDP override rejected");
    }),
  });
}
it("exposes native/compatible/legacy patch inventory with no silent compatible fallback", async () => {
  const fallback = vi
    .spyOn(FingerprintInjector.prototype, "attachFingerprintToPuppeteer")
    .mockResolvedValue();
  const page = { setUserAgent: vi.fn(), isClosed: () => false };
  const fingerprint = { fingerprint: { navigator: { userAgentData: {} } }, headers: {} };
  try {
    const compatible = host("compatible");
    await expect(compatible.injectFingerprintSafely(page, fingerprint)).rejects.toThrow(
      "CDP override rejected",
    );
    expect(fallback).not.toHaveBeenCalled();
    expect(compatible.getCompatibilityState().patches.map((p: any) => p.id)).toEqual([
      "cdp-identity",
    ]);
    const legacy = host("legacy");
    await legacy.injectFingerprintSafely(page, fingerprint);
    expect(fallback).toHaveBeenCalledOnce();
    expect(legacy.getCompatibilityState().fallbacks).toEqual(["fingerprint-injector@2.1.82"]);
    expect(legacy.getCompatibilityState().patches.map((p: any) => p.id)).toContain("legacy-script");
    const native = host("native");
    expect(native.getCompatibilityState().patches).toEqual([]);
    expect(native.isFingerprintInjectionEnabled()).toBe(false);
  } finally {
    fallback.mockRestore();
  }
});
