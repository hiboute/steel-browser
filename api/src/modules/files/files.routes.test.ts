import Fastify from "fastify";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileService } from "../../services/file.service.js";
import { schemas } from "../../plugins/schemas.js";
import filesRoutes from "./files.routes.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "steel-scoped-files-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const files = new FileService({
    baseFilesPath: path.join(dir, "idle"),
    prebuiltArchiveDir: path.join(dir, "idle-archive"),
    sessionFilesPath: path.join(dir, "sessions"),
    watchFiles: false,
  });
  cleanup.push(() => files.close());
  const app = Fastify();
  cleanup.push(() => app.close());
  app.decorate("fileService", files);
  app.decorate("steelBrowserConfig", {});
  const sessions = {
    findSocketSession: (id: string) => (["first", "second"].includes(id) ? { id } : undefined),
    isParked: () => false,
    touch: vi.fn(),
  };
  app.decorate("sessionService", sessions as never);
  for (const schema of schemas) app.addSchema(schema);
  await app.register(filesRoutes, { prefix: "/v1" });
  await app.ready();
  return { app, files, dir, sessions };
}

describe("session files", () => {
  it("isolates same-name downloads, lists relative paths, and never falls back to another session", async () => {
    const { app, files } = await setup();
    await files.forSession("first").saveFile({
      filePath: "reports/result.txt",
      stream: Readable.from("first private download"),
    });
    await files.forSession("second").saveFile({
      filePath: "reports/result.txt",
      stream: Readable.from("second private download"),
    });
    const first = await app.inject("/v1/sessions/first/files/reports/result.txt");
    const second = await app.inject("/v1/sessions/second/files/reports/result.txt");
    expect(first.statusCode).toBe(200);
    expect(first.body).toBe("first private download");
    expect(second.body).toBe("second private download");
    expect((await app.inject("/v1/files?sessionId=first")).json()).toMatchObject({
      data: [{ path: "reports/result.txt" }],
    });
    expect((await app.inject("/v1/sessions/missing/files/reports/result.txt")).statusCode).toBe(
      404,
    );
    await app.inject({ method: "DELETE", url: "/v1/sessions/first/files" });
    expect((await app.inject("/v1/sessions/second/files/reports/result.txt")).body).toBe(
      "second private download",
    );
  });

  it("retains released files until expiry and preserves active sessions", async () => {
    const { files, dir } = await setup();
    for (const id of ["first", "second"]) {
      await files.forSession(id).saveFile({ filePath: "saved.txt", stream: Readable.from(id) });
      await files.markReleased(id);
      await writeFile(
        path.join(dir, "sessions", ".released", id),
        String(Date.now() - 73 * 3_600_000),
      );
    }
    await files.sweepReleased(new Set(["second"]), 72);
    expect(await files.hasSession("first")).toBe(false);
    expect(await readFile(path.join(dir, "sessions", "second", "saved.txt"), "utf8")).toBe(
      "second",
    );
    expect(() => files.forSession("../second")).toThrow("Invalid session id");
  });

  it("rebuilds an archive after Chrome writes directly without a file watcher", async () => {
    const { files } = await setup();
    const sessionFiles = files.forSession("first");
    await writeFile(path.join(sessionFiles.getBaseFilesPath(), "one.txt"), "one");
    const archive = await sessionFiles.getPrebuiltArchivePath();
    const first = await readFile(archive);
    await writeFile(path.join(sessionFiles.getBaseFilesPath(), "two.txt"), "two");
    const second = await readFile(await sessionFiles.getPrebuiltArchivePath());
    expect(second.byteLength).toBeGreaterThan(first.byteLength);
  });
});
