import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import type { PlatformStore } from "../platform/store.js";
import type { SessionService, ParkedSnapshot, Session } from "../session.service.js";
import { AccessError, type Actor } from "../control/access.js";
export interface Checkpoint {
  id: string;
  name: string;
  sourceSessionId: string;
  ownerId: string;
  createdAt: string;
  expiresAt: string | null;
  files: number;
  bytes: number;
  digest: string;
}
interface Saved {
  details: Checkpoint;
  snapshot: ParkedSnapshot;
  manifest: Record<string, { bytes: number; sha256: string }>;
}
export class CheckpointService {
  private operations = new Map<string, Promise<unknown>>();
  constructor(
    private store: PlatformStore,
    private sessions: SessionService,
    private publish: (type: string, data: unknown, id?: string) => unknown,
  ) {}
  private serial<T>(id: string, fn: () => Promise<T>) {
    const task = (this.operations.get(id) ?? Promise.resolve()).catch(() => {}).then(fn);
    this.operations.set(id, task);
    void task
      .finally(() => {
        if (this.operations.get(id) === task) this.operations.delete(id);
      })
      .catch(() => {});
    return task;
  }
  private async manifest(root: string) {
    const files: Saved["manifest"] = {};
    let bytes = 0;
    const visit = async (relative: string) => {
      for (const name of (await readdir(path.join(root, relative))).sort()) {
        const rel = path.posix.join(relative, name);
        const file = path.join(root, rel);
        const info = await lstat(file);
        if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
          throw new AccessError(
            "unsafe_checkpoint",
            "Profile contains a link or special file",
            409,
          );
        if (info.isDirectory()) await visit(rel);
        else {
          bytes += info.size;
          if (bytes > 10 * 1024 ** 3)
            throw new AccessError("checkpoint_limit", "Profile exceeds 10 GiB", 413);
          const hash = createHash("sha256");
          for await (const chunk of createReadStream(file)) hash.update(chunk);
          files[rel] = { bytes: info.size, sha256: hash.digest("hex") };
        }
      }
    };
    await visit("");
    return files;
  }
  async create(sessionId: string, input: { name: string; retentionDays?: number }, actor: Actor) {
    if (!input.name?.trim() || input.name.length > 128)
      throw new AccessError("invalid_name", "Checkpoint name must contain 1–128 characters", 400);
    const days = input.retentionDays ?? 30;
    if (!Number.isInteger(days) || days < 1 || days > 365)
      throw new AccessError("invalid_retention", "Retention must be 1–365 days", 400);
    const id = randomUUID();
    const relative = `checkpoints/${id}`;
    const temporary = this.store.path(`checkpoints/.${id}`);
    try {
      return await this.sessions.withCheckpoint(sessionId, async (snapshot) => {
        await mkdir(temporary, { recursive: true, mode: 0o700 });
        await cp(snapshot.profile, path.join(temporary, "profile"), {
          recursive: true,
          dereference: false,
          filter: (src) => !/^Singleton/.test(path.basename(src)),
        });
        const manifest = await this.manifest(path.join(temporary, "profile"));
        const details: Checkpoint = {
          id,
          name: input.name,
          sourceSessionId: sessionId,
          ownerId: actor.id,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + days * 86400000).toISOString(),
          files: Object.keys(manifest).length,
          bytes: Object.values(manifest).reduce((n, f) => n + f.bytes, 0),
          digest: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
        };
        snapshot.options = {
          ...snapshot.options,
          signal: undefined,
          browserProfile: undefined,
          cookieSets: [],
          cookieSetWriteBack: false,
        };
        await this.store.write(`checkpoints/.${id}/meta.json`, { details, snapshot, manifest });
        await rename(temporary, this.store.path(relative));
        this.publish("checkpoint.created", details, sessionId);
        return details;
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  private async saved(id: string, actor: Actor) {
    if (!/^[\w-]{1,128}$/.test(id))
      throw new AccessError("invalid_checkpoint", "Invalid checkpoint ID", 400);
    const saved = await this.store.read<Saved>(`checkpoints/${id}/meta.json`);
    if (!saved) throw new AccessError("checkpoint_not_found", "Checkpoint not found", 404);
    if (saved.details.ownerId !== actor.id && actor.role !== "operator")
      throw new AccessError("checkpoint_denied", "Checkpoint belongs to another principal");
    return saved;
  }
  async list(actor: Actor) {
    const all: Checkpoint[] = [];
    for (const id of await this.store.list("checkpoints")) {
      if (id.startsWith(".")) continue;
      try {
        all.push((await this.saved(id, actor)).details);
      } catch (error) {
        if (!(error instanceof AccessError)) throw error;
      }
    }
    return all;
  }
  async get(id: string, actor: Actor) {
    return (await this.saved(id, actor)).details;
  }
  async branch(
    id: string,
    input: { name?: string; labels?: Record<string, string> },
    actor: Actor,
  ) {
    return this.serial(id, async () => {
      const saved = await this.saved(id, actor);
      if (saved.details.expiresAt && Date.parse(saved.details.expiresAt) <= Date.now())
        throw new AccessError("checkpoint_expired", "Checkpoint has expired", 410);
      const source = this.store.path(`checkpoints/${id}/profile`);
      const actual = await this.manifest(source);
      if (JSON.stringify(actual) !== JSON.stringify(saved.manifest))
        throw new AccessError(
          "checkpoint_corrupt",
          "Checkpoint files failed integrity validation",
          409,
        );
      const sessionId = randomUUID();
      const profile = this.store.path(`parked/${sessionId}/profile`);
      await mkdir(path.dirname(profile), { recursive: true, mode: 0o700 });
      await cp(source, profile, { recursive: true });
      const snapshot = structuredClone(saved.snapshot);
      snapshot.details = {
        ...snapshot.details,
        id: sessionId,
        name: input.name ?? saved.details.name,
        // A copy is a browser of its own. Labels say what the source was for
        // (a client's session name, background work); inheriting them makes two
        // browsers answer to one name.
        labels: { ...(input.labels ?? {}), checkpoint: id },
        ownerId: actor.id,
        status: "parked",
        createdAt: new Date().toISOString(),
        resumeCount: 0,
      };
      snapshot.profile = profile;
      snapshot.ephemeral = true;
      snapshot.options = {
        ...snapshot.options,
        sessionId,
        browserProfile: undefined,
        userDataDir: profile,
        persist: false,
        _principal: actor,
        name: snapshot.details.name,
        labels: snapshot.details.labels,
        signal: undefined,
      };
      try {
        const result = await this.sessions.importCheckpoint(snapshot);
        this.publish("checkpoint.branched", { checkpointId: id, sessionId }, sessionId);
        const { cdpService, proxyServer, completion, complete, ...details } = result as Session;
        return details;
      } catch (error) {
        if (!this.sessions.getSession(sessionId)) await this.store.remove(`parked/${sessionId}`);
        throw error;
      }
    });
  }
  async remove(id: string, actor: Actor) {
    return this.serial(id, async () => {
      await this.saved(id, actor);
      await this.store.remove(`checkpoints/${id}`);
      this.publish("checkpoint.deleted", { id });
    });
  }
  async sweep() {
    const actor: Actor = { id: "system", role: "operator", authenticated: true };
    for (const c of await this.list(actor))
      if (c.expiresAt && Date.parse(c.expiresAt) <= Date.now()) await this.remove(c.id, actor);
  }
}
