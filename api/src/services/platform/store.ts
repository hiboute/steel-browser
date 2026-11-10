import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** Atomic JSON and serialized JSONL writes using the cookie-library v1 envelope. */
export class PlatformStore {
  private readonly key?: Buffer;
  private readonly pending = new Map<string, Promise<unknown>>();
  readonly root: string;

  constructor(root: string, secret?: string) {
    this.root = path.resolve(root);
    this.key = secret ? createHash("sha256").update(secret).digest() : undefined;
  }

  path(relative: string): string {
    const resolved = path.resolve(this.root, relative);
    if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) {
      throw new Error("Storage path escapes STEEL_DATA_DIR");
    }
    return resolved;
  }

  encode(value: unknown): string {
    const raw = JSON.stringify(value);
    if (!this.key) return raw;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(raw, "utf8"), cipher.final()]);
    return JSON.stringify({
      v: 1,
      alg: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    });
  }

  decode<T>(raw: string): T {
    const value = JSON.parse(raw);
    if (value?.alg !== "aes-256-gcm") return value as T;
    if (!this.key)
      throw new Error("Encrypted Steel data requires STEEL_DATA_KEY or COOKIE_LIBRARY_KEY");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(value.iv, "base64"));
    decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(value.data, "base64")),
        decipher.final(),
      ]).toString("utf8"),
    );
  }

  /** Serialize mutations of one path, including after a failed prior operation. */
  private serial<T>(relative: string, action: () => Promise<T>): Promise<T> {
    const key = this.path(relative);
    const task = (this.pending.get(key) ?? Promise.resolve()).catch(() => undefined).then(action);
    this.pending.set(key, task);
    void task
      .finally(() => {
        if (this.pending.get(key) === task) this.pending.delete(key);
      })
      .catch(() => undefined);
    return task;
  }

  private async atomic(relative: string, raw: string): Promise<void> {
    const target = this.path(relative);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, raw, { mode: 0o600 });
      await rename(temp, target);
    } finally {
      await rm(temp, { force: true });
    }
  }

  async read<T>(relative: string): Promise<T | undefined> {
    try {
      return this.decode<T>(await readFile(this.path(relative), "utf8"));
    } catch (error: any) {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  write(relative: string, value: unknown): Promise<void> {
    return this.serial(relative, () => this.atomic(relative, this.encode(value)));
  }

  append(relative: string, value: unknown): Promise<void> {
    return this.serial(relative, async () => {
      const target = this.path(relative);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const file = await open(target, "a+", 0o600);
      try {
        const { size } = await file.stat();
        if (size) {
          const last = Buffer.alloc(1);
          await file.read(last, 0, 1, size - 1);
          if (last[0] !== 10) {
            // Recover a killed append before adding another committed line.
            let cursor = size;
            let truncateAt = 0;
            while (cursor > 0) {
              const start = Math.max(0, cursor - 65536);
              const block = Buffer.alloc(cursor - start);
              await file.read(block, 0, block.length, start);
              const newline = block.lastIndexOf(10);
              if (newline >= 0) {
                truncateAt = start + newline + 1;
                break;
              }
              cursor = start;
            }
            await file.truncate(truncateAt);
          }
        }
        await file.appendFile(`${this.encode(value)}\n`);
      } finally {
        await file.close();
      }
    });
  }

  async readLines<T>(relative: string): Promise<T[]> {
    let raw: string;
    try {
      raw = await readFile(this.path(relative), "utf8");
    } catch (error: any) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    // A killed process can leave the final append incomplete. Never conceal corrupt committed lines.
    const lines = raw.split("\n");
    if (lines.at(-1) !== "") lines.pop();
    return lines.filter(Boolean).map((line) => this.decode<T>(line));
  }

  rewriteLines(relative: string, values: unknown[]): Promise<void> {
    return this.serial(relative, () =>
      this.atomic(relative, values.map((value) => `${this.encode(value)}\n`).join("")),
    );
  }

  /** Retention compaction shares the append lock and cannot discard concurrent new entries. */
  updateLines<T>(relative: string, update: (values: T[]) => T[]): Promise<void> {
    return this.serial(relative, async () => {
      const values = update(await this.readLines<T>(relative));
      await this.atomic(relative, values.map((value) => `${this.encode(value)}\n`).join(""));
    });
  }

  remove(relative: string): Promise<void> {
    if (this.path(relative) === this.root) throw new Error("Cannot remove the data root");
    return this.serial(relative, () => rm(this.path(relative), { recursive: true, force: true }));
  }

  async list(relative: string): Promise<string[]> {
    try {
      return await readdir(this.path(relative));
    } catch (error: any) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.pending.values()]);
  }
}
