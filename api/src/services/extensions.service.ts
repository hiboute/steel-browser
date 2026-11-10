import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { inflateRaw } from "node:zlib";
import { fileURLToPath } from "node:url";
import { ExtensionName, ExtensionDetails } from "../modules/extras/extras.schema.js";
import type { z } from "zod";
import { ExtrasError } from "./extract.service.js";
import { extrasConfig } from "./extras.config.js";
import type { SessionService } from "./session.service.js";

const inflate = promisify(inflateRaw);
const bundledRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../extensions");
const maxExpandedBytes = 100 * 1024 * 1024;
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
export function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

/** CRX2/CRX3 wrap a normal ZIP archive; never execute or unpack their headers. */
export function zipPayload(archive: Buffer): Buffer {
  if (archive.subarray(0, 4).toString() !== "Cr24") return archive;
  if (archive.length < 12) throw new ExtrasError("invalid_archive", "Truncated CRX header");
  const version = archive.readUInt32LE(4);
  let offset: number;
  if (version === 2 && archive.length >= 16)
    offset = 16 + archive.readUInt32LE(8) + archive.readUInt32LE(12);
  else if (version === 3) offset = 12 + archive.readUInt32LE(8);
  else throw new ExtrasError("invalid_archive", "Only CRX2 and CRX3 archives are supported");
  if (offset >= archive.length)
    throw new ExtrasError("invalid_archive", "Invalid CRX payload offset");
  return archive.subarray(offset);
}

/** Bounded ZIP reader for stored/deflated files. Reject links, traversal, duplicates and ZIP64. */
export async function unpackExtension(archive: Buffer): Promise<Map<string, Buffer>> {
  const zip = zipPayload(archive);
  const bad = (message: string): never => {
    throw new ExtrasError("invalid_archive", message);
  };
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50 && i + 22 + zip.readUInt16LE(i + 20) === zip.length) {
      end = i;
      break;
    }
  }
  if (end < 0) return bad("ZIP directory not found");
  const count = zip.readUInt16LE(end + 10);
  const directorySize = zip.readUInt32LE(end + 12);
  const directoryStart = zip.readUInt32LE(end + 16);
  if (
    zip.readUInt16LE(end + 4) ||
    zip.readUInt16LE(end + 6) ||
    zip.readUInt16LE(end + 8) !== count ||
    count === 65535 ||
    count > 2048 ||
    directoryStart + directorySize !== end
  )
    return bad("Unsupported or oversized ZIP directory");
  const files = new Map<string, Buffer>();
  const names = new Set<string>();
  let expanded = 0;
  let cursor = directoryStart;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || zip.readUInt32LE(cursor) !== 0x02014b50)
      return bad("Invalid ZIP entry");
    const flags = zip.readUInt16LE(cursor + 8);
    const method = zip.readUInt16LE(cursor + 10);
    const crc = zip.readUInt32LE(cursor + 16);
    const compressed = zip.readUInt32LE(cursor + 20);
    const size = zip.readUInt32LE(cursor + 24);
    const nameSize = zip.readUInt16LE(cursor + 28);
    const extraSize = zip.readUInt16LE(cursor + 30);
    const commentSize = zip.readUInt16LE(cursor + 32);
    const mode = zip.readUInt32LE(cursor + 38) >>> 16;
    const offset = zip.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameSize + extraSize + commentSize;
    if (
      next > end ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      [compressed, size, offset].includes(0xffffffff)
    )
      return bad("Encrypted, ZIP64 or unsupported ZIP entry");
    const name = zip.subarray(cursor + 46, cursor + 46 + nameSize).toString("utf8");
    const parts = name.replace(/\/$/, "").split("/");
    if (
      !name ||
      name.includes("\\") ||
      /[\x00-\x1f\x7f:]/.test(name) ||
      parts.some((part) => !part || part === "." || part === "..") ||
      path.posix.isAbsolute(name)
    )
      return bad("Unsafe extension path");
    const fileType = mode & 0xf000;
    if (fileType && ![0x8000, 0x4000].includes(fileType))
      return bad("Links and special files are not allowed in extensions");
    if (names.has(name)) return bad("Duplicate ZIP path");
    names.add(name);
    expanded += size;
    if (expanded > maxExpandedBytes) return bad("Expanded extension exceeds 100 MB");
    if (offset + 30 > directoryStart || zip.readUInt32LE(offset) !== 0x04034b50)
      return bad("Invalid ZIP local header");
    const localNameSize = zip.readUInt16LE(offset + 26);
    const localExtraSize = zip.readUInt16LE(offset + 28);
    const payload = offset + 30 + localNameSize + localExtraSize;
    if (
      payload + compressed > directoryStart ||
      zip.subarray(offset + 30, offset + 30 + localNameSize).toString("utf8") !== name ||
      zip.readUInt16LE(offset + 8) !== method
    )
      return bad("Inconsistent ZIP entry");
    cursor = next;
    if (name.endsWith("/")) {
      if (size) return bad("Directory contains data");
      continue;
    }
    const data =
      method === 0
        ? Buffer.from(zip.subarray(payload, payload + compressed))
        : await inflate(zip.subarray(payload, payload + compressed), {
            maxOutputLength: Math.max(1, size),
          }).catch(() => bad("Invalid compressed extension file"));
    if (data.length !== size || crc32(data) !== crc)
      return bad("Extension file failed its integrity check");
    files.set(name, data);
  }
  if (cursor !== end) return bad("Invalid ZIP directory size");
  if (!files.has("manifest.json")) {
    const roots = new Set([...files.keys()].map((name) => name.split("/")[0]));
    if (roots.size !== 1) return bad("Extension must contain a manifest.json at its root");
    const prefix = [...roots][0] + "/";
    if (!files.has(prefix + "manifest.json")) return bad("Extension manifest.json not found");
    return new Map([...files].map(([name, value]) => [name.slice(prefix.length), value]));
  }
  return files;
}

export class ExtensionService {
  private installing = new Set<string>();
  constructor(
    private root: string,
    private sessions?: SessionService,
  ) {}

  private manifest(raw: string) {
    let manifest: any;
    try {
      manifest = JSON.parse(raw);
    } catch {
      throw new ExtrasError("invalid_manifest", "Extension manifest is not valid JSON");
    }
    if (
      ![2, 3].includes(manifest.manifest_version) ||
      typeof manifest.name !== "string" ||
      typeof manifest.version !== "string"
    )
      throw new ExtrasError(
        "invalid_manifest",
        "Extension manifest needs name, version and manifest_version 2 or 3",
      );
    return manifest;
  }
  private async entries(root: string, source: "library" | "bundled") {
    const names = await readdir(root).catch((e) => {
      if (e.code === "ENOENT") return [];
      throw e;
    });
    const entries: z.infer<typeof ExtensionDetails>[] = [];
    for (const name of names) {
      if (!ExtensionName.safeParse(name).success) continue;
      try {
        const manifest = this.manifest(
          await readFile(path.join(root, name, "manifest.json"), "utf8"),
        );
        const details = await stat(path.join(root, name));
        entries.push({
          name,
          title: manifest.name,
          version: manifest.version,
          description: manifest.description,
          manifestVersion: manifest.manifest_version,
          installedAt: details.mtime.toISOString(),
          source,
        });
      } catch {}
    }
    return entries;
  }
  async list() {
    const library = await this.entries(this.root, "library");
    const bundled = await this.entries(bundledRoot, "bundled");
    return [
      ...library,
      ...bundled.filter((item) => !library.some((installed) => installed.name === item.name)),
    ];
  }
  async install(name: string, archive: Buffer) {
    ExtensionName.parse(name);
    if (archive.length > extrasConfig.EXTENSION_MAX_MB * 1024 * 1024)
      throw new ExtrasError(
        "extension_too_large",
        "Extension archive exceeds the configured size limit",
        413,
      );
    if (this.installing.has(name))
      throw new ExtrasError(
        "extension_exists",
        "An extension operation is already in progress",
        409,
      );
    this.installing.add(name);
    const target = path.join(this.root, name);
    const temporary = path.join(this.root, `.${name}-${randomUUID()}`);
    try {
      if (
        await stat(target).then(
          () => true,
          () => false,
        )
      )
        throw new ExtrasError(
          "extension_exists",
          "Delete the existing extension before installing a replacement",
          409,
        );
      const files = await unpackExtension(archive);
      this.manifest(files.get("manifest.json")!.toString("utf8"));
      await mkdir(temporary, { recursive: true, mode: 0o700 });
      for (const [relative, data] of files) {
        const destination = path.join(temporary, relative);
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, data, { mode: 0o600, flag: "wx" });
      }
      await rename(temporary, target);
      return (await this.entries(this.root, "library")).find((item) => item.name === name)!;
    } finally {
      this.installing.delete(name);
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async installFromUrl(name: string, url: string) {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
      throw new ExtrasError("invalid_url", "Use an HTTP(S) extension URL without credentials");
    const response = await fetch(parsed, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ExtrasError(
        "extension_download_failed",
        `Extension download returned HTTP ${response.status}`,
        502,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ExtrasError("invalid_archive", "Extension download was empty");
    const buffers: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > extrasConfig.EXTENSION_MAX_MB * 1024 * 1024)
          throw new ExtrasError(
            "extension_too_large",
            "Extension download exceeds the configured size limit",
            413,
          );
        buffers.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return this.install(name, Buffer.concat(buffers));
  }

  async remove(name: string) {
    ExtensionName.parse(name);
    if (this.installing.has(name))
      throw new ExtrasError("extension_busy", "An extension operation is in progress", 409);
    if (
      this.sessions
        ?.listSessions(true)
        .some((session) => this.sessions?.getLaunchOptions(session.id)?.extensions?.includes(name))
    )
      throw new ExtrasError(
        "extension_in_use",
        "A live or parked session uses this extension",
        409,
      );
    const target = path.join(this.root, name);
    if (
      !(await stat(target).then(
        () => true,
        () => false,
      ))
    )
      throw new ExtrasError("extension_not_found", "Installed extension not found", 404);
    await rm(target, { recursive: true });
  }
}
