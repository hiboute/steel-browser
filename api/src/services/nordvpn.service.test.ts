import { describe, expect, it } from "vitest";
import { proxyHostFor } from "./nordvpn.service.js";

describe("proxyHostFor", () => {
  it("dials the proxy name the certificate covers", () => {
    expect(proxyHostFor("nl1279.nordvpn.com")).toBe("nl1279.proxy.nordvpn.com");
  });
  it("leaves other names alone", () => {
    expect(proxyHostFor("nl1279.proxy.nordvpn.com")).toBe("nl1279.proxy.nordvpn.com");
  });
});
