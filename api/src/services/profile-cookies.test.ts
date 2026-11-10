import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
vi.mock("../env.js", () => ({ env: {} }));
import {
  PROFILE_COOKIE_SIDECAR,
  readProfileCookies,
  writeProfileCookies,
} from "./profile-cookies.js";
const cookies = [
  {
    name: "sid",
    domain: "example.com",
    path: "/",
    value: "private-session-cookie",
    httpOnly: true,
  },
];
const temp = () => mkdtemp(path.join(os.tmpdir(), "profile-cookies-"));

describe("saved profile cookie sidecar", () => {
  it("encrypts cookies, reads them back, and restricts file permissions", async () => {
    const dir = await temp();
    await writeProfileCookies(dir, cookies, "test-key");
    const file = path.join(dir, PROFILE_COOKIE_SIDECAR);
    expect(await readFile(file, "utf8")).not.toContain("private-session-cookie");
    expect(await readProfileCookies(dir, "test-key")).toEqual(cookies);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
  it("reads a legacy plaintext sidecar and upgrades it on the next write", async () => {
    const dir = await temp();
    await writeFile(path.join(dir, PROFILE_COOKIE_SIDECAR), JSON.stringify(cookies));
    expect(await readProfileCookies(dir, "test-key")).toEqual(cookies);
    await writeProfileCookies(dir, cookies, "test-key");
    expect(JSON.parse(await readFile(path.join(dir, PROFILE_COOKIE_SIDECAR), "utf8")).alg).toBe(
      "aes-256-gcm",
    );
  });
  it("does not overwrite an existing encrypted sidecar with a missing or wrong key", async () => {
    const dir = await temp();
    await writeProfileCookies(dir, cookies, "right-key");
    await expect(writeProfileCookies(dir, [], "wrong-key")).rejects.toThrow();
    await expect(writeProfileCookies(dir, [], "")).rejects.toThrow();
    expect(await readProfileCookies(dir, "right-key")).toEqual(cookies);
  });
  it("returns undefined for a missing sidecar and rejects malformed stored data", async () => {
    const dir = await temp();
    expect(await readProfileCookies(dir)).toBeUndefined();
    await writeFile(path.join(dir, PROFILE_COOKIE_SIDECAR), JSON.stringify({ cookie: "bad" }));
    await expect(readProfileCookies(dir)).rejects.toThrow();
  });
});
