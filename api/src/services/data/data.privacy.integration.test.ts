import Fastify from "fastify";
import fp from "fastify-plugin";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import dataPlugin from "./data.plugin.js";
import { PlatformStore } from "../platform/store.js";
import { AccessService } from "../control/access.js";
import { SessionHookRegistry } from "../session-hooks.js";
import { RecordingService } from "../recording.service.js";
import { isSensitiveSession } from "./privacy.js";
import type { StartSessionOptions } from "../session.service.js";
import type { SearchDocument } from "./search.js";

it("inherits checkpoint privacy before recording and preserves retained-data ACLs and verified watcher ownership", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "steel-data-privacy-integration-"));
  const store = new PlatformStore(root, "test-key");
  const branch = randomUUID(),
    retained = randomUUID(),
    marked = randomUUID(),
    restored = randomUUID();
  const actor = { id: "alice", role: "agent" as const, authenticated: true };
  const token = "test-alice-verified-token-longer-than-24";
  const owners = new Map<string, string[]>([
    [branch, [actor.id]],
    [retained, [actor.id]],
    [marked, [actor.id]],
    [restored, [actor.id]],
  ]);
  const access = new AccessService(
    (id) => owners.get(id),
    () => {},
    { [token]: { id: actor.id, role: "agent" } },
  );
  const hooks = new SessionHookRegistry({ error: vi.fn() } as never);
  await store.write(`data/sensitive/${marked}.json`, { reason: "vault" });
  const session = {
    id: branch,
    status: "live",
    cdpService: { getInstrumentationLogger: () => ({ setPrivateCapture: vi.fn() }) },
  };
  let watcherDiff: (...args: any[]) => Promise<any> = async () => {
    throw new Error("Not registered");
  };
  const app = Fastify();
  await app.register(
    fp(
      async (server) => {
        server.decorate("store", store);
        server.decorate("access", access);
        server.decorate("sessionService", {
          getSession: (id: string) => (id === branch ? session : undefined),
          listSessions: () => [{ id: restored, status: "parked" }],
          getLaunchOptions: (id: string) =>
            id === restored ? { privateCapture: true } : undefined,
          getPoolStatus: () => ({ queued: 0 }),
          hooks,
        } as never);
        server.decorate("fileService", {
          forSession: () => ({ getBaseFilesPath: () => root }),
        } as never);
        server.decorate("audit", { log: async () => {} } as never);
      },
      { name: "steel-platform" },
    ),
  );
  await app.register(
    fp(
      async (server) => {
        server.decorate("watcherService", {
          setPageDiffs: (callback: typeof watcherDiff) => {
            watcherDiff = callback;
          },
        } as never);
      },
      { name: "steel-extras" },
    ),
  );
  await app.register(dataPlugin);
  try {
    await app.ready();
    expect(isSensitiveSession(restored)).toBe(true);
    expect(await store.read(`data/sensitive/${restored}.json`)).toMatchObject({
      reason: "private_capture",
    });
    const options = {
      sessionId: branch,
      credentials: {},
      privateCapture: true,
    } as StartSessionOptions;
    await hooks.run("onAdmission", options);
    expect(isSensitiveSession(branch)).toBe(true);
    const restoredOptions = { sessionId: marked, credentials: {} } as StartSessionOptions;
    await hooks.run("onAdmission", restoredOptions);
    expect(restoredOptions.privateCapture).toBe(true);
    const recording = new RecordingService({
      store,
      getSession: () => session as never,
      publish: () => {},
      log: () => {},
    });
    await expect(recording.start(branch)).rejects.toMatchObject({ code: "sensitive_session" });
    const captured = await app.dataRecords.create(
      "snapshot",
      actor.id,
      {
        text: "Retained private data",
        blocks: [],
        options: {},
        url: "https://example.com",
        observedAt: new Date().toISOString(),
      },
      retained,
    );
    const headers = { authorization: `Bearer ${token}` };
    expect(
      (await app.inject({ url: `/v1/page-snapshots/${captured.id}`, headers })).statusCode,
    ).toBe(200);
    owners.set(retained, ["bob"]);
    expect(
      (await app.inject({ url: `/v1/page-snapshots/${captured.id}`, headers })).statusCode,
    ).toBe(403);
    owners.set(retained, [actor.id]);
    const snapshot = {
      id: "watcher-snapshot",
      name: "Owned watcher",
      text: "Watcher value",
      url: "https://example.com",
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    };
    const capture = vi.spyOn(app.pageDiffs, "capture").mockResolvedValue(snapshot as never);
    await watcherDiff(
      {} as never,
      {
        ownerId: actor.id,
        client: "spoofed-attribution",
        name: "Owned watcher",
        pageDiff: {},
        state: {},
      },
      retained,
    );
    expect(capture.mock.calls[0][2]).toMatchObject({ id: actor.id, role: "agent" });
    const searchDocuments: SearchDocument[] = [];
    for await (const item of app.dataRecords.iterate<SearchDocument>("search", {
      ...actor,
      role: "operator",
    }))
      searchDocuments.push(item);
    expect(searchDocuments.find((item) => item.sourceId === snapshot.id)?.owner).toBe(actor.id);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
