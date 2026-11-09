import { mkdtemp, readFile } from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  CookieLibraryService,
  CookieSetNotFoundError,
  filterByDomains,
} from "./cookie-library.service.js";

const cookie = (name: string, domain: string, value = "v") => ({ name, value, domain, path: "/" });

async function tmp() {
  return mkdtemp(path.join(os.tmpdir(), "cookie-lib-"));
}

describe("CookieLibraryService", () => {
  it("saves, lists without values, and merges sets in order", async () => {
    const lib = new CookieLibraryService(await tmp());
    await lib.save({ name: "github", cookies: [cookie("sid", ".github.com", "a")] });
    await lib.save({
      name: "github-2",
      cookies: [cookie("sid", ".github.com", "b"), cookie("x", "example.com")],
      localStorage: { "https://github.com": { k: "1" } },
    });

    const list = await lib.list();
    expect(list.map((s) => s.name).sort()).toEqual(["github", "github-2"]);
    expect(list.find((s) => s.name === "github-2")).toMatchObject({
      cookieCount: 2,
      originCount: 1,
      domains: ["example.com", "github.com"],
    });
    expect(JSON.stringify(list)).not.toContain('"value"');

    const merged = await lib.resolve(["github", "github-2"]);
    expect(merged.cookies.find((c) => c.name === "sid")?.value).toBe("b");
    expect(merged.localStorage).toEqual({ "https://github.com": { k: "1" } });
  });

  it("encrypts files at rest when a key is set", async () => {
    const dir = await tmp();
    const lib = new CookieLibraryService(dir, "secret");
    await lib.save({ name: "bank", cookies: [cookie("token", "bank.example", "s3cr3t")] });

    const raw = await readFile(path.join(dir, "bank.json"), "utf8");
    expect(raw).not.toContain("s3cr3t");
    expect((await lib.get("bank")).cookies[0].value).toBe("s3cr3t");
    await expect(new CookieLibraryService(dir).get("bank")).rejects.toThrow(/encrypted/);
    await expect(new CookieLibraryService(dir, "wrong").get("bank")).rejects.toThrow();
  });

  it("rejects bad names and reports missing sets", async () => {
    const lib = new CookieLibraryService(await tmp());
    await expect(lib.save({ name: "../etc", cookies: [] })).rejects.toThrow(/names are/);
    await expect(lib.get("nope")).rejects.toBeInstanceOf(CookieSetNotFoundError);
  });

  it("filters cookies and origins by domain, subdomains included", () => {
    const picked = filterByDomains(
      {
        cookies: [cookie("a", ".accounts.google.com"), cookie("b", "example.com")],
        localStorage: { "https://mail.google.com": {}, "https://example.com": {} },
      },
      ["google.com"],
    );
    expect(picked.cookies.map((c) => c.name)).toEqual(["a"]);
    expect(Object.keys(picked.localStorage ?? {})).toEqual(["https://mail.google.com"]);
  });
});
