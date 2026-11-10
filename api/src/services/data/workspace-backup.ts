import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
} from "node:crypto";
import { cp, lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { z } from "zod";
import { DataError, type DataActor } from "./common.js";
import { PlatformStore } from "../platform/store.js";

const MAX_BYTES = 50 * 1024 * 1024;
const FileEntry = z
  .object({
    scope: z.string().regex(/^[a-z_-]{1,32}$/),
    path: z.string().min(1).max(1000),
    data: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const Manifest = z
  .object({
    version: z.literal(1),
    createdAt: z.string().datetime(),
    scopes: z.array(z.string()).min(1).max(10),
    files: z.array(FileEntry).max(20_000),
    requiresOriginalStoreKeys: z.literal(true),
  })
  .strict();
type ArchiveManifest = z.infer<typeof Manifest>;
const derive = (passphrase: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCallback(
      passphrase,
      salt,
      32,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
function validPassphrase(value: string) {
  if (value.length < 16 || value.length > 1024)
    throw new DataError(
      "weak_export_key",
      "Use a separate export passphrase of 16–1024 characters",
    );
}
function relativeFile(value: string) {
  if (
    value.includes("\\") ||
    value.includes("\0") ||
    path.isAbsolute(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new DataError("invalid_archive_path", "Archive contains an unsafe path");
  return value;
}
const excluded = (name: string) =>
  /^(Singleton.*|.*\.lock|LOCK|Cache|Code Cache|GPUCache|ShaderCache|Crashpad|BrowserMetrics|DevToolsActivePort)$/.test(
    name,
  );

export class WorkspaceBackup {
  private restoring = false;
  private busy = false;
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.busy)
      throw new DataError("backup_busy", "Another workspace backup operation is running", 429);
    this.busy = true;
    try {
      return await action();
    } finally {
      this.busy = false;
    }
  }
  export(actor: DataActor, scopes: string[], passphrase: string) {
    return this.exclusive(() => this.createArchive(actor, scopes, passphrase));
  }
  stage(
    actor: DataActor,
    input: {
      archive: string;
      passphrase: string;
      scopes: string[];
      conflict: "reject" | "replace";
    },
  ) {
    return this.exclusive(() => this.createStage(actor, input));
  }
  constructor(
    readonly roots: Record<string, string>,
    private recoveryRoot: string,
    private assertQuiescent: () => void | Promise<void> = () => {},
  ) {}
  private authorize(actor: DataActor, scopes: string[]) {
    if (actor.role !== "operator")
      throw new DataError("operator_required", "Workspace recovery requires an operator", 403);
    if (
      !scopes.length ||
      new Set(scopes).size !== scopes.length ||
      scopes.some((scope) => !this.roots[scope])
    )
      throw new DataError("invalid_scope", "Choose configured, unique export scopes");
  }
  private async createArchive(actor: DataActor, scopes: string[], passphrase: string) {
    this.authorize(actor, scopes);
    validPassphrase(passphrase);
    await this.assertQuiescent();
    let bytes = 0;
    const files: ArchiveManifest["files"] = [];
    const walk = async (scope: string, directory: string, prefix = "", onlyFile?: string) => {
      const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (onlyFile && entry.name !== onlyFile) continue;
        if (excluded(entry.name)) continue;
        if (
          scope === "identities" &&
          !prefix &&
          !["profiles", "history", "sites", "site-history", "continuity"].includes(entry.name)
        )
          continue;
        const relative = relativeFile(prefix + entry.name);
        const filename = path.join(directory, entry.name);
        const before = await lstat(filename);
        if (before.isSymbolicLink())
          throw new DataError(
            "unsafe_workspace",
            "Workspace contains a symlink; remove it or exclude this scope",
          );
        if (before.isDirectory()) {
          await walk(scope, filename, relative + "/");
          continue;
        }
        if (!before.isFile())
          throw new DataError("unsafe_workspace", "Workspace contains a non-regular file");
        bytes += before.size;
        if (bytes > MAX_BYTES || files.length >= 20_000)
          throw new DataError(
            "archive_too_large",
            "Workspace export exceeds 50 MiB or 20,000 files",
          );
        const buffer = await readFile(filename);
        const after = await lstat(filename);
        if (
          before.ino !== after.ino ||
          before.mtimeMs !== after.mtimeMs ||
          buffer.length !== before.size
        )
          throw new DataError(
            "workspace_changed",
            "Workspace changed during export; stop writers and retry",
            409,
          );
        files.push({
          scope,
          path: relative,
          data: buffer.toString("base64"),
          sha256: createHash("sha256").update(buffer).digest("hex"),
        });
      }
    };
    for (const scope of scopes) {
      const location = path.resolve(this.roots[scope]);
      if (["warm", "workflows"].includes(scope)) {
        if (
          !(await lstat(location).catch((error) => {
            if (error.code === "ENOENT") return null;
            throw error;
          }))
        ) {
          const empty = Buffer.from(
            JSON.stringify(
              scope === "warm" ? [] : { schemaVersion: 1, procedures: {}, schedules: {} },
            ),
          );
          files.push({
            scope,
            path: path.basename(location),
            data: empty.toString("base64"),
            sha256: createHash("sha256").update(empty).digest("hex"),
          });
          bytes += empty.length;
        } else await walk(scope, path.dirname(location), "", path.basename(location));
      } else await walk(scope, location);
    }
    const manifest: ArchiveManifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      scopes,
      files,
      requiresOriginalStoreKeys: true,
    };
    const salt = randomBytes(16),
      iv = randomBytes(12),
      key = await derive(passphrase, salt);
    try {
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from("steel-workspace-v1"));
      const encrypted = Buffer.concat([
        cipher.update(gzipSync(JSON.stringify(manifest))),
        cipher.final(),
      ]);
      const envelope = {
        version: 1,
        algorithm: "aes-256-gcm+scrypt",
        salt: salt.toString("base64"),
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: encrypted.toString("base64"),
      };
      return {
        archive: Buffer.from(JSON.stringify(envelope)).toString("base64"),
        version: 1,
        scopes,
        files: files.length,
        bytes,
        createdAt: manifest.createdAt,
        requiresOriginalStoreKeys: true,
      };
    } finally {
      key.fill(0);
    }
  }
  async decrypt(archive: string, passphrase: string) {
    validPassphrase(passphrase);
    if (archive.length > MAX_BYTES * 2)
      throw new DataError("archive_too_large", "Archive exceeds limit");
    try {
      const envelope = z
        .object({
          version: z.literal(1),
          algorithm: z.literal("aes-256-gcm+scrypt"),
          salt: z.string().length(24),
          iv: z.string().length(16),
          tag: z.string().length(24),
          data: z.string(),
        })
        .strict()
        .parse(JSON.parse(Buffer.from(archive, "base64").toString("utf8")));
      const key = await derive(passphrase, Buffer.from(envelope.salt, "base64"));
      let raw: Buffer;
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
        decipher.setAAD(Buffer.from("steel-workspace-v1"));
        decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
        raw = Buffer.concat([
          decipher.update(Buffer.from(envelope.data, "base64")),
          decipher.final(),
        ]);
      } finally {
        key.fill(0);
      }
      const manifest = Manifest.parse(
        JSON.parse(gunzipSync(raw, { maxOutputLength: MAX_BYTES * 1.5 }).toString("utf8")),
      );
      let bytes = 0;
      const names = new Set<string>();
      for (const file of manifest.files) {
        relativeFile(file.path);
        if (!manifest.scopes.includes(file.scope) || names.has(file.scope + "/" + file.path))
          throw new Error("Duplicate or undeclared scope");
        names.add(file.scope + "/" + file.path);
        const data = Buffer.from(file.data, "base64");
        bytes += data.length;
        if (
          bytes > MAX_BYTES ||
          data.toString("base64") !== file.data ||
          createHash("sha256").update(data).digest("hex") !== file.sha256
        )
          throw new Error("Invalid archive content");
      }
      return manifest;
    } catch (error) {
      if (error instanceof DataError) throw error;
      throw new DataError(
        "invalid_archive",
        "Archive authentication, key or format validation failed",
        400,
      );
    }
  }
  private async createStage(
    actor: DataActor,
    input: {
      archive: string;
      passphrase: string;
      scopes: string[];
      conflict: "reject" | "replace";
    },
  ) {
    this.authorize(actor, input.scopes);
    const manifest = await this.decrypt(input.archive, input.passphrase);
    if (input.scopes.some((scope) => !manifest.scopes.includes(scope)))
      throw new DataError("scope_missing", "Requested scope is not in this archive");
    const stageId = randomUUID();
    const root = path.join(this.recoveryRoot, stageId);
    await mkdir(root, { recursive: true, mode: 0o700 });
    try {
      for (const scope of input.scopes) await mkdir(path.join(root, scope), { mode: 0o700 });
      for (const file of manifest.files.filter((entry) => input.scopes.includes(entry.scope))) {
        const destination = path.join(root, file.scope, relativeFile(file.path));
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, Buffer.from(file.data, "base64"), { mode: 0o600, flag: "wx" });
      }
      await writeFile(
        path.join(root, "manifest.json"),
        JSON.stringify({
          version: 1,
          stageId,
          scopes: input.scopes,
          conflict: input.conflict,
          createdAt: new Date().toISOString(),
          requiresOriginalStoreKeys: true,
        }),
        { mode: 0o600, flag: "wx" },
      );
      return {
        stageId,
        automationDisabled: true,
        status: "staged",
        scopes: input.scopes,
        restartRequired: true,
        activation:
          "Stop Steel and activate this stage with workspace-recovery CLI; existing workspace has not changed",
        requiresOriginalStoreKeys: true,
      };
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }
  private async disableRestoredAutomation(scope: string, prepared: string) {
    if (!["workflows", "watchers", "warm"].includes(scope)) return;
    const key = process.env.STEEL_DATA_KEY || process.env.COOKIE_LIBRARY_KEY;
    const store = new PlatformStore(
      ["warm", "workflows"].includes(scope) ? path.dirname(prepared) : prepared,
      key,
    );
    if (scope === "workflows") {
      const manifest = await store.read<Record<string, any>>(path.basename(prepared));
      if (!manifest) return;
      if (
        manifest.schemaVersion !== 1 ||
        !manifest.schedules ||
        typeof manifest.schedules !== "object"
      )
        throw new DataError(
          "unsupported_workflows",
          "Workflow manifest cannot be safely restored by this version",
        );
      for (const schedule of Object.values(manifest.schedules) as Record<string, unknown>[]) {
        schedule.enabled = false;
        delete schedule.webhookHash;
      }
      await store.write(path.basename(prepared), manifest);
    } else if (scope === "warm") {
      const basename = path.basename(prepared);
      const warm = await store.read<Record<string, unknown>[]>(basename);
      if (!Array.isArray(warm))
        throw new DataError("invalid_warm", "Warm-session settings cannot be restored");
      await store.write(
        basename,
        warm.map((item) => ({ ...item, enabled: false, status: "disabled" })),
      );
    } else {
      for (const name of await store.list(".")) {
        if (!/^[A-Za-z0-9_-]+\.json$/.test(name)) continue;
        const record = await store.read<Record<string, any>>(name);
        if (record)
          await store.write(name, {
            ...record,
            enabled: false,
            state: { ...record.state, running: false },
          });
      }
    }
  }
  private async writeJournal(root: string, entries: unknown) {
    const target = path.join(root, "activation-journal.json");
    const temporary = `${target}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(entries));
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, target);
      const directory = await open(root, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
  /** Recover an interrupted swap, or deliberately roll back a completed activation. */
  async rollback(stageId: string) {
    if (!/^[a-f0-9-]{36}$/.test(stageId))
      throw new DataError("invalid_stage", "Invalid recovery stage");
    const root = path.join(this.recoveryRoot, stageId);
    const journal = z
      .array(
        z
          .object({
            target: z.string(),
            backup: z.string(),
            prepared: z.string(),
            hadOriginal: z.boolean(),
            installed: z.boolean(),
          })
          .strict(),
      )
      .max(10)
      .parse(JSON.parse(await readFile(path.join(root, "activation-journal.json"), "utf8")));
    const allowed = new Set(Object.values(this.roots).map((value) => path.resolve(value)));
    for (const entry of journal)
      if (
        !allowed.has(entry.target) ||
        entry.backup !== `${entry.target}.before-${stageId}` ||
        entry.prepared !== `${entry.target}.restore-${stageId}`
      )
        throw new DataError("invalid_journal", "Recovery journal target is invalid");
    for (const entry of journal.reverse()) {
      if (entry.hadOriginal) {
        if (await lstat(entry.backup).catch(() => null)) {
          await rm(entry.target, { recursive: true, force: true });
          await rename(entry.backup, entry.target);
        }
      } else if (!(await lstat(entry.prepared).catch(() => null)))
        await rm(entry.target, { recursive: true, force: true });
      await rm(entry.prepared, { recursive: true, force: true });
    }
    await rm(path.join(root, "activation-journal.json"), { force: true });
    await rm(path.join(root, "activated.json"), { force: true });
    return { status: "rolled_back", stageId };
  }
  /** Offline-only activation. Directories are swapped with rollback; API never mutates a live workspace. */
  async activate(stageId: string) {
    if (!/^[a-f0-9-]{36}$/.test(stageId))
      throw new DataError("invalid_stage", "Invalid recovery stage");
    if (this.restoring) throw new DataError("restore_busy", "A restore is already running", 409);
    this.restoring = true;
    const root = path.join(this.recoveryRoot, stageId);
    const moved: {
      target: string;
      backup: string;
      prepared: string;
      hadOriginal: boolean;
      installed: boolean;
    }[] = [];
    try {
      await this.assertQuiescent();
      if (await lstat(path.join(root, "activated.json")).catch(() => null))
        throw new DataError(
          "already_activated",
          "This stage was already activated; use rollback explicitly",
          409,
        );
      if (await lstat(path.join(root, "activation-journal.json")).catch(() => null))
        await this.rollback(stageId);
      const manifest = z
        .object({
          version: z.literal(1),
          stageId: z.literal(stageId),
          scopes: z.array(z.string()).min(1),
          conflict: z.enum(["reject", "replace"]),
          createdAt: z.string(),
          requiresOriginalStoreKeys: z.literal(true),
        })
        .parse(JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")));
      this.authorize(
        { id: "offline-operator", role: "operator", authenticated: true },
        manifest.scopes,
      );
      for (const scope of manifest.scopes) {
        const target = path.resolve(this.roots[scope]);
        const exists = await lstat(target).catch(() => null);
        if (
          exists?.isSymbolicLink() ||
          (exists &&
            !(["warm", "workflows"].includes(scope) ? exists.isFile() : exists.isDirectory()))
        )
          throw new DataError(
            "unsafe_target",
            "Restore target must have the configured regular file/directory type",
          );
        if (
          manifest.conflict === "reject" &&
          exists &&
          (["warm", "workflows"].includes(scope) ? exists.size > 0 : (await readdir(target)).length)
        )
          throw new DataError(
            "restore_conflict",
            "Destination contains data; choose replace explicitly",
            409,
          );
      }
      for (const scope of manifest.scopes) {
        const target = path.resolve(this.roots[scope]);
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        const backup = `${target}.before-${stageId}`;
        const prepared = `${target}.restore-${stageId}`;
        if (await lstat(backup).catch(() => null))
          throw new DataError(
            "restore_conflict",
            "A prior rollback directory exists; inspect it before retrying",
            409,
          );
        const source = ["warm", "workflows"].includes(scope)
          ? path.join(root, scope, path.basename(target))
          : path.join(root, scope);
        await cp(source, prepared, {
          recursive: true,
          errorOnExist: true,
          force: false,
          filter: async (source) => {
            const info = await lstat(source);
            if (info.isSymbolicLink())
              throw new DataError("unsafe_stage", "Recovery stage contains a symlink");
            return true;
          },
        });
        try {
          await this.disableRestoredAutomation(scope, prepared);
        } catch (error) {
          await rm(prepared, { recursive: true, force: true });
          throw error;
        }
        const hadOriginal = !!(await lstat(target).catch(() => null));
        const item = { target, backup, prepared, hadOriginal, installed: false };
        moved.push(item);
        await this.writeJournal(root, moved);
        if (hadOriginal) await rename(target, backup);
        await rename(prepared, target);
        item.installed = true;
        await this.writeJournal(root, moved);
      }
      // Retain old directories for a deliberate rollback; never erase the only prior copy.
      await writeFile(
        path.join(root, "activated.json"),
        JSON.stringify({
          at: new Date().toISOString(),
          backups: moved.filter((item) => item.hadOriginal).map((item) => item.backup),
        }),
        { mode: 0o600 },
      );
      return {
        status: "activated",
        automationDisabled: true,
        scopes: manifest.scopes,
        rollbackDirectories: moved.filter((item) => item.hadOriginal).map((item) => item.backup),
      };
    } catch (error) {
      for (const item of moved.reverse()) {
        if (item.installed) await rm(item.target, { recursive: true, force: true });
        if (item.hadOriginal && (await lstat(item.backup).catch(() => null)))
          await rename(item.backup, item.target);
        await rm(item.prepared, { recursive: true, force: true });
      }
      throw error;
    } finally {
      this.restoring = false;
    }
  }
}
