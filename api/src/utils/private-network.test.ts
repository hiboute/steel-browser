import { describe, expect, test, vi } from "vitest";
import { createPrivateNetworkCheck, parseHostList, trustOwnUrlPrefix } from "./private-network.js";

const dnsError = (code: string) => Object.assign(new Error(code), { code });

describe("private network check", () => {
  test("judges literal addresses without a lookup", async () => {
    const resolve = vi.fn();
    const check = createPrivateNetworkCheck({ resolve });
    for (const url of [
      "http://127.0.0.1/",
      "http://10.1.2.3:8080/x",
      "https://192.168.1.15/",
      "http://172.20.0.2/",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.64.0.1/",
      "http://0.0.0.0/",
      "http://[::1]/",
      "http://[fd00::1]/",
      "http://[fe80::1]/",
      "http://[::ffff:10.0.0.1]/",
      "ws://127.0.0.1:9222/devtools",
      "http://localhost:3000/",
      "http://app.localhost/",
      "http://metadata.google.internal/",
      // What Chrome makes of the decimal and hexadecimal spellings of 127.0.0.1.
      "http://2130706433/",
      "http://0x7f.1/",
    ])
      expect(await check(url), url).toBe(true);
    for (const url of ["https://1.1.1.1/", "http://93.184.216.34/", "https://[2606:4700::1111]/"])
      expect(await check(url), url).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
  });

  test("lets what is not a network request through", async () => {
    const check = createPrivateNetworkCheck({ resolve: vi.fn() });
    for (const url of ["data:text/plain,hi", "blob:http://127.0.0.1/1", "about:blank", "nonsense"])
      expect(await check(url), url).toBe(false);
  });

  test("refuses a name when any of its addresses is private", async () => {
    const check = createPrivateNetworkCheck({
      resolve: async (name) =>
        ({
          "public.example": ["93.184.216.34"],
          "mixed.example": ["93.184.216.34", "10.0.0.5"],
          "nas.example": ["192.168.1.20"],
          "empty.example": [],
        })[name] ?? [],
    });
    expect(await check("https://public.example/a")).toBe(false);
    expect(await check("https://mixed.example/a")).toBe(true);
    expect(await check("https://NAS.example./a")).toBe(true);
    expect(await check("https://empty.example/")).toBe(true);
  });

  test("a name that does not exist goes through, any other failure refuses", async () => {
    const check = createPrivateNetworkCheck({
      resolve: async (name) => {
        throw dnsError(name === "gone.example" ? "ENOTFOUND" : "ESERVFAIL");
      },
    });
    expect(await check("https://gone.example/")).toBe(false);
    expect(await check("https://broken.example/")).toBe(true);
  });

  test("refuses when the lookup does not answer in time", async () => {
    const check = createPrivateNetworkCheck({
      resolve: () => new Promise(() => {}),
      dnsTimeoutMs: 20,
    });
    expect(await check("https://slow.example/")).toBe(true);
  });

  test("keeps an answer for a while, then asks again", async () => {
    let at = 0;
    const resolve = vi.fn(async () => ["93.184.216.34"]);
    const check = createPrivateNetworkCheck({ resolve, ttlMs: 1000, now: () => at });
    await Promise.all([check("https://a.example/1"), check("https://a.example/2")]);
    expect(resolve).toHaveBeenCalledTimes(1);
    at = 999;
    await check("https://a.example/3");
    expect(resolve).toHaveBeenCalledTimes(1);
    at = 1000;
    resolve.mockResolvedValueOnce(["10.0.0.1"]);
    expect(await check("https://a.example/4")).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  test("allowed hosts stay reachable, with their subdomains", async () => {
    const check = createPrivateNetworkCheck({
      allowHosts: parseHostList(" Intranet.example., 10.0.0.9 "),
      resolve: async () => ["10.0.0.5"],
    });
    expect(await check("http://intranet.example/")).toBe(false);
    expect(await check("http://wiki.intranet.example/")).toBe(false);
    expect(await check("http://10.0.0.9/")).toBe(false);
    expect(await check("http://notintranet.example/")).toBe(true);
    expect(await check("http://10.0.0.10/")).toBe(true);
  });

  test("a page the API serves itself stays reachable until it is taken away", async () => {
    const check = createPrivateNetworkCheck({ resolve: vi.fn() });
    const forget = trustOwnUrlPrefix("http://127.0.0.1:4010/secretpath/");
    expect(await check("http://127.0.0.1:4010/secretpath/fixture")).toBe(false);
    expect(await check("http://127.0.0.1:4010/other")).toBe(true);
    expect(await check("http://127.0.0.1:4011/secretpath/fixture")).toBe(true);
    forget();
    expect(await check("http://127.0.0.1:4010/secretpath/fixture")).toBe(true);
  });
});
