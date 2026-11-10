import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PlatformStore } from "../platform/store.js";
import { CheckpointService } from "./checkpoints.service.js";
const actor = { id: "agent", role: "agent" as const, authenticated: true };
let root: string, store: PlatformStore, service: CheckpointService, snapshot: any, imports: any[];
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "steel-checkpoint-"));
  store = new PlatformStore(root, "test-key");
  const profile = path.join(root, "original");
  await mkdir(path.join(profile, "Default"), { recursive: true });
  await writeFile(path.join(profile, "Default", "state"), "original");
  snapshot = {
    details: { id: "source", status: "parked", ownerId: actor.id },
    profile,
    options: { credentials: {}, cookieSets: ["shared-login"], cookieSetWriteBack: true },
    cookies: [{ name: "secret", value: "cookie-value" }],
    tabs: [{ url: "https://owned.test", storage: { draft: "retained" } }],
  };
  imports = [];
  const sessions = {
    withCheckpoint: async (_id: string, fn: any) => fn(structuredClone(snapshot)),
    importCheckpoint: async (s: any) => {
      imports.push(s);
      return s.details;
    },
    getSession: () => undefined,
  };
  service = new CheckpointService(store, sessions as any, () => {});
});
afterEach(() => rm(root, { recursive: true, force: true }));
describe("immutable browser checkpoints", () => {
  it("branches independent profiles with retained tab/storage and no cookie-library writeback", async () => {
    const saved = await service.create("source", { name: "before-edit" }, actor);
    const first = await service.branch(saved.id, {}, actor);
    const second = await service.branch(saved.id, { name: "experiment" }, actor);
    expect(first.id).not.toBe(second.id);
    expect(imports[0].tabs[0].storage.draft).toBe("retained");
    expect(imports[0].options.cookieSets).toEqual([]);
    expect(imports[0].options.cookieSetWriteBack).toBe(false);
    await writeFile(path.join(imports[0].profile, "Default", "state"), "changed");
    expect(await readFile(path.join(imports[1].profile, "Default", "state"), "utf8")).toBe(
      "original",
    );
    expect(await readFile(path.join(snapshot.profile, "Default", "state"), "utf8")).toBe(
      "original",
    );
    expect(JSON.stringify(saved)).not.toContain("cookie-value");
    expect(await readFile(store.path(`checkpoints/${saved.id}/meta.json`), "utf8")).not.toContain(
      "cookie-value",
    );
    expect(await service.list({ ...actor, id: "stranger" })).toEqual([]);
  });
  it("detects tampering and missing files across service restart", async () => {
    const saved = await service.create("source", { name: "consistent" }, actor);
    await writeFile(store.path(`checkpoints/${saved.id}/profile/Default/state`), "tampered");
    await expect(service.branch(saved.id, {}, actor)).rejects.toMatchObject({
      code: "checkpoint_corrupt",
    });
    await rm(store.path(`checkpoints/${saved.id}/profile/Default/state`));
    await expect(service.branch(saved.id, {}, actor)).rejects.toMatchObject({
      code: "checkpoint_corrupt",
    });
    expect(imports).toHaveLength(0);
  });
  it("refuses links and expires retained copies without altering original profile", async () => {
    await symlink(
      path.join(snapshot.profile, "Default", "state"),
      path.join(snapshot.profile, "outside"),
    );
    await expect(service.create("source", { name: "unsafe" }, actor)).rejects.toMatchObject({
      code: "unsafe_checkpoint",
    });
    await rm(path.join(snapshot.profile, "outside"));
    const saved = await service.create("source", { name: "expired" }, actor);
    const metadata = await store.read<any>(`checkpoints/${saved.id}/meta.json`);
    metadata.details.expiresAt = new Date(0).toISOString();
    await store.write(`checkpoints/${saved.id}/meta.json`, metadata);
    await expect(service.branch(saved.id, {}, actor)).rejects.toMatchObject({
      code: "checkpoint_expired",
    });
    await service.sweep();
    expect(await service.list(actor)).toEqual([]);
    expect(await readFile(path.join(snapshot.profile, "Default", "state"), "utf8")).toBe(
      "original",
    );
  });
});
