import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { ExtensionService, crc32, unpackExtension, zipPayload } from "./extensions.service.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function zip(
  entries: Array<{ name: string; content: string; mode?: number; compressed?: boolean }>,
) {
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const content = Buffer.from(entry.content);
    const payload = entry.compressed ? deflateRawSync(content) : content;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.compressed ? 8 : 0, 8);
    local.writeUInt32LE(crc32(content), 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, payload);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.compressed ? 8 : 0, 10);
    central.writeUInt32LE(crc32(content), 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0x81a4) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    offset += local.length + name.length + payload.length;
  }
  const directoryBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directoryBytes, end]);
}
const manifest = JSON.stringify({ manifest_version: 3, name: "Test extension", version: "1.0.0" });

describe("extension archives", () => {
  it("unpacks a wrapped deflated extension and validates each file", async () => {
    const files = await unpackExtension(
      zip([
        { name: "package/manifest.json", content: manifest, compressed: true },
        { name: "package/scripts/content.js", content: "console.log('hello')", compressed: true },
      ]),
    );
    expect([...files.keys()]).toEqual(["manifest.json", "scripts/content.js"]);
    expect(files.get("manifest.json")?.toString()).toBe(manifest);
  });
  it.each(["../escape", "/absolute", "a/../../escape", "a\\escape", "C:/drive", "a//b"])(
    "rejects unsafe path %s",
    async (name) => {
      await expect(
        unpackExtension(
          zip([
            { name: "manifest.json", content: manifest },
            { name, content: "bad" },
          ]),
        ),
      ).rejects.toThrow("Unsafe extension path");
    },
  );
  it("rejects symlinks, duplicate names and corrupt payloads", async () => {
    await expect(
      unpackExtension(
        zip([
          { name: "manifest.json", content: manifest },
          { name: "link", content: "/tmp", mode: 0xa1ff },
        ]),
      ),
    ).rejects.toThrow("Links");
    await expect(
      unpackExtension(
        zip([
          { name: "manifest.json", content: manifest },
          { name: "manifest.json", content: manifest },
        ]),
      ),
    ).rejects.toThrow("Duplicate");
    const corrupted = zip([{ name: "manifest.json", content: manifest }]);
    corrupted[30 + "manifest.json".length] ^= 1;
    await expect(unpackExtension(corrupted)).rejects.toThrow("integrity");
  });
  it("accepts CRX2 and CRX3 wrappers and rejects truncated headers", async () => {
    const payload = zip([{ name: "manifest.json", content: manifest }]);
    const crx2 = Buffer.alloc(16);
    crx2.write("Cr24");
    crx2.writeUInt32LE(2, 4);
    const crx3 = Buffer.alloc(12);
    crx3.write("Cr24");
    crx3.writeUInt32LE(3, 4);
    expect(zipPayload(Buffer.concat([crx2, payload]))).toEqual(payload);
    expect(zipPayload(Buffer.concat([crx3, payload]))).toEqual(payload);
    expect(() => zipPayload(Buffer.from("Cr24"))).toThrow("Truncated");
  });
  it("installs atomically, rejects overwrite and protects extensions referenced by sessions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "steel-extension-test-"));
    directories.push(root);
    const sessions = {
      listSessions: () => [{ id: "s" }],
      getLaunchOptions: () => ({ extensions: ["test"] }),
    };
    const service = new ExtensionService(root, sessions as never);
    const result = await service.install(
      "test",
      zip([{ name: "manifest.json", content: manifest }]),
    );
    expect(result).toMatchObject({ name: "test", version: "1.0.0", source: "library" });
    expect(await readFile(path.join(root, "test/manifest.json"), "utf8")).toBe(manifest);
    await expect(
      service.install("test", zip([{ name: "manifest.json", content: manifest }])),
    ).rejects.toThrow("Delete the existing");
    await expect(service.remove("test")).rejects.toThrow("live or parked");
  });
});
