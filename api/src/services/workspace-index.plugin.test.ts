import Fastify from "fastify";
import fp from "fastify-plugin";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import plugin from "./workspace-index.plugin.js";
import { AccessService, type Actor } from "./control/access.js";
import { PlatformStore } from "./platform/store.js";
import { PlatformEvents } from "./platform/events.js";
import { DataRecords } from "./data/common.js";
import { SessionSearch, type SearchDocument } from "./data/search.js";
import { markSensitiveSession } from "./data/privacy.js";

const alice: Actor = { id: "alice", role: "agent", authenticated: true };
const bob: Actor = { id: "bob", role: "agent", authenticated: true };
const roots: string[] = [];
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function state(suffix: string) {
  const secret = "COMMAND_PAYLOAD_MUST_NEVER_BE_SEARCHABLE_" + suffix;
  const id = "run-" + suffix;
  const sessionId = "session-" + suffix;
  return {
    secret,
    id,
    sessionId,
    owners: new Map([[sessionId, [alice.id]]]),
    runs: new Map([
      [
        id,
        {
          id,
          ownerId: alice.id,
          sessionId,
          status: "paused",
          cursor: 0,
          steps: [{ kind: "commands", input: { text: secret } }],
          results: [{ output: { value: secret } }],
          metadata: { name: "Alpha task", arbitrary: secret },
          pauseReason: secret,
        },
      ],
    ]),
    procedures: new Map([
      [
        "procedure-" + suffix,
        {
          id: "procedure-" + suffix,
          ownerId: alice.id,
          name: "Alpha procedure",
          description: "Reusable work",
          version: 1,
          steps: [{ text: secret }],
        },
      ],
    ]),
    receipts: new Map([
      [
        id,
        {
          id,
          ownerId: alice.id,
          sessionId,
          summary: "Alpha receipt",
          status: "waiting",
          runStatus: "paused",
          assertions: [{ actual: secret, expected: secret }],
        },
      ],
    ]),
    missingProcedureOnGet: false,
  };
}
type Fixture = ReturnType<typeof state>;
function own<T extends { ownerId: string }>(value: T | undefined, actor: Actor): T {
  if (!value || (actor.role !== "operator" && value.ownerId !== actor.id))
    throw new Error("Denied or deleted");
  return value;
}
async function setup(fixture: Fixture, root?: string) {
  if (!root) {
    root = await mkdtemp(path.join(os.tmpdir(), "steel-index-integration-"));
    roots.push(root);
  }
  const app = Fastify();
  apps.push(app);
  const store = new PlatformStore(root, "test-encryption-key");
  const events = new PlatformEvents();
  const access = new AccessService(
    (id) => fixture.owners.get(id),
    () => {},
    {},
  );
  const records = new DataRecords(store, 30, (actor, id) => access.assertRead(actor, id));
  const search = new SessionSearch(records, async () => true);
  await app.register(
    fp(
      async (server) => {
        server.decorate("store", store);
        server.decorate("events", events);
        server.decorate("access", access);
        server.decorate("sessionSearch", search);
        server.decorate("runs", {
          get: (id: string, actor: Actor) => own(fixture.runs.get(id), actor),
          list: (actor: Actor) =>
            [...fixture.runs.values()].filter(
              (run) => actor.role === "operator" || run.ownerId === actor.id,
            ),
        } as never);
      },
      { name: "next-platform" },
    ),
  );
  await app.register(
    fp(
      async (server) => {
        server.decorate("workflowService", {
          getProcedure: (id: string, _version: unknown, actor: Actor) => {
            if (fixture.missingProcedureOnGet) throw new Error("Deleted during startup");
            return own(fixture.procedures.get(id), actor);
          },
          listProcedures: (actor: Actor) =>
            [...fixture.procedures.values()].filter(
              (record) => actor.role === "operator" || record.ownerId === actor.id,
            ),
          listReceipts: async (actor: Actor) =>
            [...fixture.receipts.values()].filter(
              (record) => actor.role === "operator" || record.ownerId === actor.id,
            ),
        } as never);
      },
      { name: "steel-workflows" },
    ),
  );
  await app.register(plugin);
  await app.ready();
  return { app, store, events, search, records, root };
}

it("backfills only approved metadata and updates run, procedure and receipt events", async () => {
  const fixture = state("metadata"),
    { search, events, records } = await setup(fixture);
  expect(
    (await search.search(alice, { q: "Alpha" })).results.map((hit) => hit.kind).sort(),
  ).toEqual(["procedure", "receipt", "run"]);
  expect((await search.search(alice, { q: fixture.secret })).results).toEqual([]);
  const documents: SearchDocument[] = [];
  for await (const record of records.iterate<SearchDocument>("search", {
    ...alice,
    role: "operator",
  }))
    documents.push(record);
  expect(JSON.stringify(documents)).not.toContain(fixture.secret);
  fixture.runs.get(fixture.id)!.status = "completed";
  fixture.procedures.values().next().value!.name = "Beta procedure";
  fixture.receipts.get(fixture.id)!.summary = "Beta receipt";
  fixture.receipts.get(fixture.id)!.status = "verified";
  events.publish("run.updated", { run: { id: fixture.id, input: fixture.secret } });
  events.publish("workflow.procedure.updated", {
    id: fixture.procedures.keys().next().value,
    input: fixture.secret,
  });
  events.publish("workflow.receipt.updated", { id: fixture.id, actual: fixture.secret });
  await vi.waitFor(async () => expect((await search.search(alice, { q: "Beta" })).total).toBe(2));
  expect((await search.search(alice, { q: "completed" })).results).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: "run" })]),
  );
  expect((await search.search(alice, { q: fixture.secret })).total).toBe(0);
});

it("checks current source/session ACLs without deleting records when one reader is denied", async () => {
  const fixture = state("access"),
    { search, store, events } = await setup(fixture);
  const before = await store.list("data/search");
  expect((await search.search(bob, { q: "Alpha" })).results).toEqual([]);
  fixture.owners.set(fixture.sessionId, [bob.id]);
  expect((await search.search(alice, { q: "Alpha" })).results.map((hit) => hit.kind)).toEqual([
    "procedure",
  ]);
  expect(await store.list("data/search")).toEqual(before);
  fixture.owners.set(fixture.sessionId, [alice.id]);
  expect((await search.search(alice, { q: "Alpha" })).total).toBe(3);
  fixture.runs.delete(fixture.id);
  expect((await search.search(alice, { q: "Alpha" })).results.map((hit) => hit.kind)).toEqual([
    "procedure",
  ]);
  expect(await store.list("data/search")).toEqual(before);
  const procedureId = fixture.procedures.keys().next().value!;
  fixture.procedures.delete(procedureId);
  events.publish("workflow.procedure.deleted", { id: procedureId });
  await vi.waitFor(async () =>
    expect(await store.list("data/search")).toHaveLength(before.length - 1),
  );
  expect((await search.search(alice, { q: "Alpha" })).results).toEqual([]);
});

it("immediately hides all source kinds for sensitive sessions and refuses later index writes", async () => {
  const fixture = state("private"),
    { search, store } = await setup(fixture);
  for (const kind of ["snapshot", "artifact", "extract"])
    await search.index({
      sourceId: kind,
      owner: alice.id,
      sessionId: fixture.sessionId,
      title: "Alpha " + kind,
      text: "visible before private capture",
      href: "/?view=data",
      kind,
    });
  expect((await search.search(alice, { q: "Alpha" })).total).toBe(6);
  markSensitiveSession(fixture.sessionId);
  expect((await search.search(alice, { q: "Alpha" })).results.map((hit) => hit.kind)).toEqual([
    "procedure",
  ]);
  const before = await store.list("data/search");
  await search.index({
    sourceId: "later",
    owner: alice.id,
    sessionId: fixture.sessionId,
    title: "Alpha private artifact",
    text: fixture.secret,
    href: "/?view=data",
    kind: "artifact",
  });
  expect(await store.list("data/search")).toEqual(before);
});

it("rebuilds current metadata on restart and tolerates a source disappearing during backfill", async () => {
  const fixture = state("restart"),
    first = await setup(fixture);
  await first.app.close();
  fixture.runs.get(fixture.id)!.metadata.name = "Resumed task";
  fixture.receipts.get(fixture.id)!.summary = "Resumed receipt";
  fixture.missingProcedureOnGet = true;
  const second = await setup(fixture, first.root);
  expect((await second.search.search(alice, { q: "Resumed" })).total).toBe(2);
  expect((await second.search.search(alice, { q: "Alpha" })).results).toEqual([]);
  fixture.missingProcedureOnGet = false;
  fixture.procedures.values().next().value!.name = "Resumed procedure";
  second.events.publish("workflow.procedure.updated", {
    id: fixture.procedures.keys().next().value,
  });
  await vi.waitFor(async () =>
    expect((await second.search.search(alice, { q: "Resumed" })).total).toBe(3),
  );
});
