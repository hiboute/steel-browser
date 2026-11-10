import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as mupdf from "mupdf";
import { PlatformStore } from "../platform/store.js";
import { DataRecords, type DataActor } from "./common.js";
import { groundFields } from "./grounding.js";
import { SessionSearch } from "./search.js";
import { WorkspaceBackup } from "./workspace-backup.js";
import { VaultService } from "./vault.js";
import { ArtifactService } from "./artifacts.js";
import { createBrowserLogger } from "../cdp/instrumentation/browser-logger.js";
import { BrowserEventType } from "../../types/enums.js";
import { comparePixels } from "./page-diffs.js";

const actor: DataActor = { id: "alice", role: "agent", authenticated: true };
const operator: DataActor = { id: "operator", role: "operator", authenticated: true };
const temporary: string[] = [];
async function directory() {
  const name = await mkdtemp(path.join(os.tmpdir(), "steel-data-"));
  temporary.push(name);
  return name;
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((name) => rm(name, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

it("grounds nested leaves against captured evidence, identifies absent and invented values", () => {
  const evidence = groundFields(
    {
      product: { name: "Tea", price: 12, stocked: true },
      bogus: "unicorn",
      missing: null,
      escaped: [{ "a/b": "Tokyo" }],
    },
    {
      url: "https://shop.test/",
      observedAt: "2026-11-10T00:00:00Z",
      text: "Tea costs 12. Tokyo store.",
      blocks: [{ selector: "#price", text: "Tea costs 12." }],
    },
  );
  expect(evidence.find((item) => item.path === "/product/name")).toMatchObject({
    status: "grounded",
    selector: "#price",
    excerpt: "Tea costs 12. Tokyo store.",
  });
  expect(evidence.find((item) => item.path === "/bogus")?.status).toBe("uncertain");
  expect(evidence.find((item) => item.path === "/product/stocked")?.status).toBe("uncertain");
  expect(evidence.find((item) => item.path === "/missing")?.status).toBe("missing");
  expect(evidence.some((item) => item.path === "/escaped/0/a~1b")).toBe(true);
  expect(
    groundFields({ price: 12 }, { url: "x", observedAt: "x", text: "price 123" })[0].status,
  ).toBe("uncertain");
});

it("does not expose another owner's search hits, removes deleted sources and respects Unicode", async () => {
  const store = new PlatformStore(await directory(), "encryption-key");
  const records = new DataRecords(store);
  const existing = new Set(["a", "b"]);
  const search = new SessionSearch(records, async (record) => existing.has(record.sourceId));
  await search.index({
    sourceId: "a",
    owner: actor.id,
    title: "Café 東京",
    text: "temperature 12",
    kind: "extract",
    href: "/sessions/a",
  });
  await search.index({
    sourceId: "b",
    owner: "bob",
    title: "Café private",
    text: "secret-password",
    kind: "extract",
    href: "https://untrusted.test/",
  });
  expect((await search.search(actor, { q: "CAFÉ 東京" })).results).toHaveLength(1);
  expect((await search.search(actor, { q: "private" })).total).toBe(0);
  expect(JSON.stringify(await store.list("data/search"))).not.toContain("Café");
  existing.delete("a");
  expect((await search.search(actor, { q: "CAFÉ" })).total).toBe(0);
  await expect(search.search(actor, { q: "x", cursor: -1 })).rejects.toMatchObject({
    code: "invalid_cursor",
  });
});

it("revoked session access also removes owned retained records from reads and listings", async () => {
  let permitted = true;
  const records = new DataRecords(new PlatformStore(await directory()), 30, () => {
    if (!permitted) throw new Error("revoked");
  });
  const record = await records.create("snapshot", actor.id, { text: "private" }, "session");
  permitted = false;
  await expect(records.get("snapshot", record.id, actor)).rejects.toThrow("revoked");
  expect(await records.list("snapshot", actor)).toEqual([]);
});

describe("encrypted workspace recovery", () => {
  it("authenticates archive, stages without overwrite and restores selected scopes with rollback copy", async () => {
    const root = await directory();
    const original = path.join(root, "original"),
      target = path.join(root, "target");
    await mkdir(original);
    await mkdir(target);
    await writeFile(path.join(original, "state.json"), "private-cookie-value");
    await writeFile(path.join(target, "state.json"), "old-value");
    const source = new WorkspaceBackup({ profiles: original }, path.join(root, "recovery"));
    const archive = await source.export(operator, ["profiles"], "separate export passphrase");
    expect(archive.archive).not.toContain("private-cookie-value");
    await expect(source.decrypt(archive.archive, "incorrect passphrase")).rejects.toMatchObject({
      code: "invalid_archive",
    });
    const destination = new WorkspaceBackup({ profiles: target }, path.join(root, "recovery"));
    const stage = await destination.stage(operator, {
      archive: archive.archive,
      passphrase: "separate export passphrase",
      scopes: ["profiles"],
      conflict: "replace",
    });
    expect(await readFile(path.join(target, "state.json"), "utf8")).toBe("old-value");
    const activated = await destination.activate(stage.stageId);
    expect(await readFile(path.join(target, "state.json"), "utf8")).toBe("private-cookie-value");
    expect(await readFile(path.join(activated.rollbackDirectories[0], "state.json"), "utf8")).toBe(
      "old-value",
    );
    await destination.rollback(stage.stageId);
    expect(await readFile(path.join(target, "state.json"), "utf8")).toBe("old-value");
  });
  it("rejects agents, symlink exports, live workspaces and destructive restore conflicts", async () => {
    const root = await directory();
    await mkdir(path.join(root, "profiles"));
    await writeFile(path.join(root, "outside"), "secret");
    const service = new WorkspaceBackup(
      { profiles: path.join(root, "profiles") },
      path.join(root, "recovery"),
    );
    await expect(
      service.export(actor, ["profiles"], "separate export passphrase"),
    ).rejects.toMatchObject({ code: "operator_required" });
    await symlink(path.join(root, "outside"), path.join(root, "profiles", "escape"));
    await expect(
      service.export(operator, ["profiles"], "separate export passphrase"),
    ).rejects.toMatchObject({ code: "unsafe_workspace" });
    const busy = new WorkspaceBackup({ profiles: root }, root, () => {
      throw new Error("busy");
    });
    await expect(busy.export(operator, ["profiles"], "separate export passphrase")).rejects.toThrow(
      "busy",
    );
  });
  it("restores warm settings and workflow schedules disabled without retaining webhook approval", async () => {
    const root = await directory();
    const source = path.join(root, "source"),
      target = path.join(root, "target");
    const sourceStore = new PlatformStore(source);
    await sourceStore.write("warm.json", [{ name: "mail", enabled: true, status: "live" }]);
    await sourceStore.write("workflows/manifest.json", {
      schemaVersion: 1,
      procedures: {},
      schedules: { daily: { enabled: true, webhookHash: "prior-hash" } },
    });
    const exporter = new WorkspaceBackup(
      {
        warm: path.join(source, "warm.json"),
        workflows: path.join(source, "workflows", "manifest.json"),
      },
      path.join(root, "stages"),
    );
    const archive = await exporter.export(
      operator,
      ["warm", "workflows"],
      "separate export passphrase",
    );
    const importer = new WorkspaceBackup(
      {
        warm: path.join(target, "warm.json"),
        workflows: path.join(target, "workflows", "manifest.json"),
      },
      path.join(root, "stages"),
    );
    const stage = await importer.stage(operator, {
      archive: archive.archive,
      passphrase: "separate export passphrase",
      scopes: ["warm", "workflows"],
      conflict: "replace",
    });
    expect(await importer.activate(stage.stageId)).toMatchObject({ automationDisabled: true });
    const restored = new PlatformStore(target);
    expect(await restored.read("warm.json")).toMatchObject([
      { enabled: false, status: "disabled" },
    ]);
    expect(await restored.read("workflows/manifest.json")).toMatchObject({
      schedules: { daily: { enabled: false } },
    });
    expect(JSON.stringify(await restored.read("workflows/manifest.json"))).not.toContain(
      "prior-hash",
    );
  });
});

it("vault refuses unapproved caller, selector and changed origin before resolving values", async () => {
  const resolve = vi.fn(async () => "never-in-a-log");
  const vault = new VaultService(
    JSON.stringify({
      login: {
        provider: "env",
        locator: "TEST_SECRET",
        origin: "https://example.com",
        selectors: ["#password"],
        clients: [actor.id],
      },
    }),
    resolve,
  );
  const frame = { url: () => "https://evil.example/", evaluate: vi.fn() };
  const page = { url: () => "https://example.com/login", mainFrame: () => frame };
  await expect(
    vault.fill(page as never, actor, { reference: "login", selector: "#password" }),
  ).rejects.toMatchObject({ code: "origin_denied" });
  await expect(
    vault.fill(page as never, actor, { reference: "login", selector: "#evil" }),
  ).rejects.toMatchObject({ code: "target_denied" });
  await expect(
    vault.fill(
      page as never,
      { ...actor, id: "bob" },
      { reference: "login", selector: "#password" },
    ),
  ).rejects.toMatchObject({ code: "reference_denied" });
  expect(resolve).not.toHaveBeenCalled();
  expect(JSON.stringify(vault.list(actor))).not.toContain("TEST_SECRET");
});

it("does not fill after human takeover while secret retrieval is pending", async () => {
  const pending = Promise.withResolvers<string>();
  let controlled = true;
  const frame = { url: () => "https://example.com/login", evaluate: vi.fn() };
  const page = { url: () => "https://example.com/login", mainFrame: () => frame };
  const vault = new VaultService(
    JSON.stringify({
      login: {
        provider: "env",
        locator: "TEST_SECRET",
        origin: "https://example.com",
        selectors: ["#password"],
        clients: [actor.id],
      },
    }),
    () => pending.promise,
  );
  const filling = vault.fill(
    page as never,
    actor,
    { reference: "login", selector: "#password" },
    {
      assertControl: () => {
        if (!controlled) throw new Error("stale lease");
      },
    },
  );
  controlled = false;
  pending.resolve("never-fill-after-transfer");
  await expect(filling).rejects.toMatchObject({ code: "fill_failed" });
  expect(frame.evaluate).not.toHaveBeenCalled();
});

it("private browser capture stops console, storage and emitted CDP payloads including fill arguments", async () => {
  const info = vi.fn(),
    write = vi.fn(async () => {});
  const logger = createBrowserLogger({
    baseLogger: { info, error: vi.fn() },
    storage: { write } as never,
  });
  logger.setPrivateCapture!();
  logger.record({
    type: BrowserEventType.CDPCommand,
    timestamp: new Date().toISOString(),
    cdp: {
      sessionId: "test",
      command: "Runtime.callFunctionOn",
      params: { arguments: [{ value: "secret" }] },
    },
  });
  logger.resetContext();
  logger.record({
    type: BrowserEventType.CDPEvent,
    timestamp: new Date().toISOString(),
    cdp: { name: "Runtime.consoleAPICalled", params: { value: "secret" } },
  });
  expect(info).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});

it("processes real PDF bytes in a bounded worker and rejects path escape or unsupported files", async () => {
  const root = await directory(),
    files = path.join(root, "files");
  await mkdir(files);
  const document = new mupdf.PDFDocument();
  const font = document.addSimpleFont(new mupdf.Font("Helvetica"));
  const resources = document.newDictionary();
  resources.put("Font", document.newDictionary());
  resources.get("Font").put("F1", font);
  const page = document.addPage(
    [0, 0, 300, 200],
    0,
    resources,
    "BT /F1 18 Tf 20 150 Td (Invoice total 42) Tj ET BT /F1 12 Tf 20 100 Td (Item) Tj 150 0 Td (Cost) Tj -150 -30 Td (Tea) Tj 150 0 Td (42) Tj ET",
  );
  document.insertPage(-1, page);
  const buffer = Buffer.from(document.saveToBuffer("").asUint8Array());
  document.destroy();
  await writeFile(path.join(files, "invoice.pdf"), buffer);
  const artifacts = new ArtifactService(
    new DataRecords(new PlatformStore(path.join(root, "data"))),
    () => files,
  );
  const result = await artifacts.process("session", actor, { path: "invoice.pdf" });
  expect(result.text).toContain("Invoice total 42");
  expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.pages).toHaveLength(1);
  expect(result.pages[0].tables).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        method: "geometry-candidate",
        rows: [
          ["Item", "Cost"],
          ["Tea", "42"],
        ],
      }),
    ]),
  );
  await expect(artifacts.process("session", actor, { path: "../outside" })).rejects.toMatchObject({
    code: "invalid_path",
  });
  await writeFile(path.join(files, "bad.bin"), Buffer.from([0, 1, 2]));
  await expect(artifacts.process("session", actor, { path: "bad.bin" })).rejects.toMatchObject({
    code: "unsupported_artifact",
  });
  await rm(path.join(files, "invoice.pdf"));
  await expect(artifacts.get(result.id, actor)).rejects.toMatchObject({ code: "source_deleted" });
});

it("compares rendered pixels with an explicit changed ratio", () => {
  const white = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 10, 10], false);
  white.clear(255);
  const black = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 10, 10], false);
  black.clear(0);
  try {
    expect(comparePixels(Buffer.from(white.asPNG()), Buffer.from(white.asPNG()))).toMatchObject({
      status: "unchanged",
      changedRatio: 0,
    });
    expect(comparePixels(Buffer.from(white.asPNG()), Buffer.from(black.asPNG()))).toMatchObject({
      status: "changed",
      changedRatio: 1,
    });
  } finally {
    white.destroy();
    black.destroy();
  }
});

it.skipIf(!existsSync("/usr/bin/tesseract"))(
  "runs real OCR on a rendered image and returns recognized text",
  async () => {
    const root = await directory(),
      files = path.join(root, "files");
    await mkdir(files);
    const document = new mupdf.PDFDocument();
    const font = document.addSimpleFont(new mupdf.Font("Helvetica"));
    const resources = document.newDictionary();
    resources.put("Font", document.newDictionary());
    resources.get("Font").put("F1", font);
    document.insertPage(
      -1,
      document.addPage(
        [0, 0, 600, 200],
        0,
        resources,
        "BT /F1 36 Tf 30 100 Td (Invoice total 42) Tj ET",
      ),
    );
    const page = document.loadPage(0),
      pixels = page.toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false);
    try {
      await writeFile(path.join(files, "scan.png"), pixels.asPNG());
    } finally {
      pixels.destroy();
      page.destroy();
      document.destroy();
    }
    const service = new ArtifactService(
      new DataRecords(new PlatformStore(path.join(root, "data"))),
      () => files,
    );
    const result = await service.process("session", actor, { path: "scan.png", ocr: true });
    expect(result.ocr).toBe("completed");
    expect(result.text).toMatch(/Invoice total 42/i);
    await expect(service.verify(result.id, actor, "0".repeat(64))).rejects.toMatchObject({
      code: "artifact_changed",
    });
    expect(await service.verify(result.id, actor, result.sha256)).toMatchObject({
      sha256: result.sha256,
    });
    await writeFile(path.join(files, "scan.png"), "modified");
    await expect(service.verify(result.id, actor, result.sha256)).rejects.toMatchObject({
      code: "source_changed",
    });
  },
);
