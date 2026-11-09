import { describe, expect, it } from "vitest";
import { BrowserPool } from "./browser-pool.service.js";

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
