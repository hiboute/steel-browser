import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlatformStore } from "../platform/store.js";
import { PlatformEvents } from "../platform/events.js";
import { OwnershipService } from "../control/ownership.js";
import { RunService } from "../runs/runs.service.js";
import { DataError, DataRecords } from "../data/common.js";
import { ArtifactService } from "../data/artifacts.js";
import type { SessionService } from "../session.service.js";
import type { SessionCommands } from "../commands/registry.js";
import workflowPlugin from "./workflows.plugin.js";
import { MAX_FILE_EVIDENCE_BYTES, type WorkflowActor } from "./workflows.types.js";

const alice: WorkflowActor = { id: "alice", role: "agent", authenticated: true };
let root: string, store: PlatformStore, artifacts: ArtifactService, control: OwnershipService;
let app: FastifyInstance, runs: RunService, sensitive: boolean;
const contents = Buffer.from("item,count\nReport,1\n");
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "steel-file-receipt-"));
  await mkdir(path.join(root, "files", "owned"), { recursive: true });
  await mkdir(path.join(root, "files", "other"), { recursive: true });
  store = new PlatformStore(root, "test-encryption-key");
  control = new OwnershipService(store);
  await control.initialize();
  await control.registerResource("owned", "alice");
  await control.registerResource("other", "bob");
  const events = new PlatformEvents();
  const sessions = {
    getSession: (id: string) => ({ id, status: "live" }),
    isParked: () => false,
    holdActivity: () => () => {},
  } as unknown as SessionService;
  runs = new RunService(
    store,
    sessions,
    { reset: () => {} } as unknown as SessionCommands,
    control,
    (type, data, id) => events.publish(type, data, id),
  );
  const records = new DataRecords(store, 30, (actor, id) => {
    if (!control.canRead(id, actor)) throw new DataError("not_found", "Source unavailable", 404);
  });
  artifacts = new ArtifactService(records, (id) => path.join(root, "files", id));
  sensitive = false;
  app = Fastify();
  await app.register(
    fp(
      async (instance) => {
        instance.decorate("store", store);
        instance.decorate("events", events);
      },
      { name: "steel-platform" },
    ),
  );
  await app.register(workflowPlugin, {
    runtime: runs,
    replayOrigins: ["https://fixture.test"],
    evidenceAllowed: () => true,
    isSensitiveSession: () => sensitive,
    actor: (request) => ({
      id: String(request.headers["x-test-user"] ?? "alice"),
      role: request.headers["x-test-role"] === "operator" ? "operator" : "agent",
      authenticated: true,
    }),
    captureFileEvidence: async (ctx, assertion) => {
      control.assert(ctx.run.sessionId!, ctx.actor, ctx.controlToken);
      const file = await artifacts.captureEvidence(
        assertion.artifactId,
        ctx.actor,
        assertion.sha256,
        MAX_FILE_EVIDENCE_BYTES,
      );
      control.assert(ctx.run.sessionId!, ctx.actor, ctx.controlToken);
      return file;
    },
  });
  await app.ready();
  await runs.initialize();
});
afterEach(async () => {
  await runs.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
async function artifact(sessionId = "owned", owner = alice) {
  await writeFile(path.join(root, "files", sessionId, "report.csv"), contents);
  return artifacts.process(sessionId, owner, { path: "report.csv" });
}
async function runFile(id: string, hash: string, bytes?: number) {
  const create = await app.inject({
    method: "POST",
    url: "/v1/procedures",
    payload: {
      name: "Verify downloaded report",
      inputSchema: {
        type: "object",
        properties: { artifact: { type: "string" }, hash: { type: "string" } },
        required: ["artifact", "hash"],
        additionalProperties: false,
      },
      steps: [
        {
          id: "file",
          kind: "assert_file",
          assertion: {
            id: "report",
            label: "Downloaded report",
            artifactId: { $input: "artifact" },
            sha256: { $input: "hash" },
            ...(bytes === undefined ? {} : { bytes }),
          },
        },
      ],
    },
  });
  expect(create.statusCode).toBe(200);
  const started = await app.inject({
    method: "POST",
    url: `/v1/procedures/${create.json().id}/run`,
    payload: {
      sessionId: "owned",
      inputs: { artifact: id, hash },
      idempotencyKey: create.json().id,
    },
  });
  expect(started.statusCode).toBe(200);
  const runId = started.json().id;
  for (let i = 0; i < 100; i++) {
    if (["completed", "failed", "uncertain", "paused"].includes(runs.get(runId, alice).status))
      break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(runs.get(runId, alice).status).toBe("completed");
  const response = await app.inject(`/v1/receipts/${runId}`);
  expect(response.statusCode).toBe(200);
  return response.json();
}
it("serves an immutable encrypted real file through the owner-only evidence API after source deletion", async () => {
  const file = await artifact();
  const receipt = await runFile(file.id, file.sha256, contents.length);
  expect(receipt.status).toBe("verified");
  const evidence = receipt.assertions[0].evidence;
  expect(evidence).toMatchObject({
    type: "file",
    sourceArtifactId: file.id,
    name: "report.csv",
    mime: "text/plain",
    bytes: contents.length,
    sha256: createHash("sha256").update(contents).digest("hex"),
  });
  expect(JSON.stringify(receipt)).not.toContain(contents.toString());
  expect(JSON.stringify(receipt)).not.toContain(root);
  const persisted = await readFile(
    store.path(`workflows/evidence/${evidence.artifactId}.json`),
    "utf8",
  );
  expect(JSON.parse(persisted).alg).toBe("aes-256-gcm");
  expect(persisted).not.toContain(contents.toString("base64"));
  await rm(path.join(root, "files", "owned", "report.csv"));
  const downloaded = await app.inject(`/v1/workflow-evidence/${evidence.artifactId}`);
  expect(downloaded.statusCode).toBe(200);
  expect(downloaded.rawPayload).toEqual(contents);
  expect(downloaded.headers["content-disposition"]).toBe('attachment; filename="report.csv"');
  expect(downloaded.headers["x-evidence-sha256"]).toBe(file.sha256);
  expect(downloaded.headers["cache-control"]).toBe("private, no-store");
  expect(
    (
      await app.inject({
        url: `/v1/workflow-evidence/${evidence.artifactId}`,
        headers: { "x-test-user": "bob" },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        url: `/v1/workflow-evidence/${evidence.artifactId}`,
        headers: { "x-test-user": "bob", "x-test-role": "operator" },
      })
    ).statusCode,
  ).toBe(403);
  sensitive = true;
  expect((await app.inject(`/v1/workflow-evidence/${evidence.artifactId}`)).statusCode).toBe(404);
});
it("cannot verify a hash/size mismatch, changed source, missing file or another owner's artifact", async () => {
  const file = await artifact();
  expect((await runFile(file.id, "0".repeat(64))).status).toBe("failed");
  expect((await runFile(file.id, file.sha256, contents.length + 1)).status).toBe("failed");
  await writeFile(path.join(root, "files", "owned", "report.csv"), "modified");
  expect((await runFile(file.id, file.sha256)).status).toBe("failed");
  await rm(path.join(root, "files", "owned", "report.csv"));
  expect((await runFile(file.id, file.sha256)).status).toBe("uncertain");
  const foreign = await artifact("other", { ...alice, id: "bob" });
  expect((await runFile(foreign.id, foreign.sha256)).status).toBe("uncertain");
  expect(await store.list("workflows/evidence")).toEqual([]);
});
it("refuses same-owner files from a different session and paths escaping the owned directory", async () => {
  await control.assignResource("other", "alice");
  const other = await artifact("other");
  expect((await runFile(other.id, other.sha256)).status).toBe("uncertain");
  const file = await artifact();
  await rm(path.join(root, "files", "owned", "report.csv"));
  await symlink(
    path.join(root, "files", "other", "report.csv"),
    path.join(root, "files", "owned", "report.csv"),
  );
  const receipt = await runFile(file.id, file.sha256);
  expect(receipt.status).not.toBe("verified");
  expect(receipt.assertions[0].evidence).toBeUndefined();
});
it("suppresses file bytes when privacy changes during capture or encrypted persistence", async () => {
  const file = await artifact();
  const capture = artifacts.captureEvidence.bind(artifacts);
  vi.spyOn(artifacts, "captureEvidence").mockImplementation(async (...args) => {
    const result = await capture(...args);
    sensitive = true;
    return result;
  });
  const receipt = await runFile(file.id, file.sha256);
  expect(receipt.status).toBe("uncertain");
  expect(receipt.assertions[0].actual).toContain("redacted");
  expect(await store.list("workflows/evidence")).toEqual([]);
  vi.restoreAllMocks();
  sensitive = false;
  const write = store.write.bind(store);
  vi.spyOn(store, "write").mockImplementation(async (key, value) => {
    await write(key, value);
    if (key.startsWith("workflows/evidence/")) sensitive = true;
  });
  expect((await runFile(file.id, file.sha256)).status).toBe("uncertain");
  expect(await store.list("workflows/evidence")).toEqual([]);
  expect(await store.list("workflows/file-evidence-expiry")).toEqual([]);
  vi.restoreAllMocks();
  sensitive = false;
  vi.spyOn(store, "write").mockImplementation(async (key, value) => {
    await write(key, value);
    if (key.startsWith("workflows/file-evidence-expiry/")) sensitive = true;
  });
  expect((await runFile(file.id, file.sha256)).status).toBe("uncertain");
  expect(await store.list("workflows/evidence")).toEqual([]);
  expect(await store.list("workflows/file-evidence-expiry")).toEqual([]);
});
it("bounds allocation and rejects oversized or corrupted evidence", async () => {
  const large = path.join(root, "files", "owned", "large.txt");
  await writeFile(large, "");
  await truncate(large, MAX_FILE_EVIDENCE_BYTES + 1);
  const records = new DataRecords(store);
  const stat = await import("node:fs/promises").then((fs) => fs.stat(large));
  const file = await records.create(
    "artifact",
    alice.id,
    {
      name: "large.txt",
      sourcePath: "large.txt",
      sha256: "a".repeat(64),
      bytes: stat.size,
      sourceModifiedAt: stat.mtimeMs,
      mime: "text/plain",
    },
    "owned",
  );
  expect((await runFile(file.id, file.sha256)).status).toBe("uncertain");
  expect(await store.list("workflows/evidence")).toEqual([]);
  const valid = await artifact();
  const receipt = await runFile(valid.id, valid.sha256);
  const id = receipt.assertions[0].evidence.artifactId;
  const saved = await store.read<any>(`workflows/evidence/${id}.json`);
  await store.write(`workflows/evidence/${id}.json`, {
    ...saved,
    data: Buffer.from("corrupt").toString("base64"),
  });
  expect((await app.inject(`/v1/workflow-evidence/${id}`)).statusCode).toBe(409);
});
it("fails closed without encryption and refuses file evidence during isolated replay", async () => {
  const file = await artifact();
  const receipt = await runFile(file.id, file.sha256);
  await expect(
    app.workflowService.startReplay(
      {
        baselineRunId: receipt.runId,
        inputs: { artifact: file.id, hash: file.sha256 },
        candidate: { label: "no user files" },
        allowedOrigins: ["https://fixture.test"],
        idempotencyKey: "replay",
      },
      alice,
    ),
  ).rejects.toMatchObject({ code: "unsafe_replay_command" });
  vi.spyOn(store, "encrypted", "get").mockReturnValue(false);
  expect((await runFile(file.id, file.sha256)).status).toBe("uncertain");
});

it("expires retained files on read and sweeps expired or interrupted copies without removing live copies", async () => {
  const file = await artifact();
  const first = await runFile(file.id, file.sha256);
  const evidence = first.assertions[0].evidence;
  const second = await runFile(file.id, file.sha256);
  const secondId = second.assertions[0].evidence.artifactId;
  const later = new Date(Date.parse(evidence.expiresAt) + 1);
  vi.spyOn(app.workflowService as any, "now").mockReturnValue(later);
  expect((await app.inject(`/v1/workflow-evidence/${evidence.artifactId}`)).statusCode).toBe(410);
  expect(await store.read(`workflows/evidence/${evidence.artifactId}.json`)).toBeUndefined();
  const third = await runFile(file.id, file.sha256);
  const thirdId = third.assertions[0].evidence.artifactId;
  // Simulate a crash after journaling expiry but before writing any bytes.
  await store.write("workflows/file-evidence-expiry/interrupted.json", {
    expiresAt: later.toISOString(),
  });
  // Both retained blobs and missing-blob journals are swept; newer evidence remains valid.
  await store.write(`workflows/file-evidence-expiry/${secondId}.json`, {
    expiresAt: later.toISOString(),
  });
  await app.workflowService.tick();
  expect(await store.read(`workflows/evidence/${secondId}.json`)).toBeUndefined();
  expect(await store.read("workflows/file-evidence-expiry/interrupted.json")).toBeUndefined();
  expect((await app.inject(`/v1/workflow-evidence/${thirdId}`)).rawPayload).toEqual(contents);
});
