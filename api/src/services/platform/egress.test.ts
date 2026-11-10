import { describe, expect, it, vi } from "vitest";
import axios from "axios";
import { EgressService } from "./egress.js";

vi.mock("axios", () => ({ default: { get: vi.fn() } }));
vi.mock("../nordvpn.service.js", () => ({
  nordVpnConfigured: () => true,
  nordVpnProxy: vi.fn(async (country?: string) => ({
    url: `https://user:secret@${country || "auto"}.example:89`,
    label: "nord-server",
  })),
}));

describe("egress profiles", () => {
  it("resolves direct, named proxies, defaults, and NordVPN without publishing credentials", async () => {
    const service = new EgressService(
      JSON.stringify({
        home: { proxyUrl: "http://user:password@home.example:8080", label: "Home" },
      }),
      "home",
    );
    expect(await service.resolve()).toEqual({
      name: "home",
      proxyUrl: "http://user:password@home.example:8080",
      proxyLabel: "Home",
    });
    expect(await service.resolve("direct")).toEqual({ name: "direct" });
    expect(await service.resolve("nordvpn:FR")).toMatchObject({
      name: "nordvpn:FR",
      proxyLabel: "nordvpn:FR",
    });
    vi.mocked(axios.get).mockResolvedValue({ data: "ip=203.0.113.2\nloc=FR\n" });
    const list = await service.list();
    expect(JSON.stringify(list)).not.toMatch(/password|secret|user:|proxyUrl/);
    expect(list.profiles.find((profile) => profile.name === "home")).toMatchObject({
      healthy: true,
      publicIp: "203.0.113.2",
      country: "FR",
    });
  });

  it("deduplicates health checks and reuses the ten-minute result", async () => {
    vi.mocked(axios.get).mockReset().mockResolvedValue({ data: "ip=203.0.113.1\nloc=US\n" });
    const service = new EgressService();
    const [one, two] = await Promise.all([service.check("direct"), service.check("direct")]);
    expect(one).toEqual(two);
    expect(await service.check("direct")).toEqual(one);
    expect(axios.get).toHaveBeenCalledOnce();
  });

  it("rejects invalid configuration and reports failed probes without exposing their URLs", async () => {
    expect(() => new EgressService('{"direct":{"proxyUrl":"http://example.com"}}')).toThrow();
    expect(() => new EgressService('{"bad":{"proxyUrl":"file:///etc/passwd"}}')).toThrow();
    const service = new EgressService();
    await expect(service.resolve("unknown")).rejects.toMatchObject({
      code: "invalid_egress",
      statusCode: 400,
    });
    vi.mocked(axios.get).mockRejectedValue(new Error("request to secret URL failed"));
    expect(await service.check("direct")).toMatchObject({
      healthy: false,
      publicIp: null,
      country: null,
    });
  });
});
