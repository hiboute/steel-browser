import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import extrasRoutes from "./extras.routes.js";
import { WatcherSettings } from "./extras.schema.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
const id = "00000000-0000-4000-8000-000000000001";
async function setup() {
  const app = Fastify();
  apps.push(app);
  app.addSchema({ $id: "SessionDetails", type: "object", properties: { id: { type: "string" } } });
  app.decorateRequest("steelClient", "ui");
  const record = {
    ...WatcherSettings.parse({
      name: "Price",
      url: "https://example.com",
      intervalMinutes: 120,
      enabled: false,
      condition: { type: "lt", value: 10 },
      notify: { cooldownMinutes: 180, onErrorAfter: 5 },
    }),
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    state: { nextRunAt: new Date().toISOString(), consecutiveErrors: 0 },
  };
  const watchers = {
    get: vi.fn(() => record),
    list: () => [record],
    update: vi.fn(async (_id, settings) => ({ ...record, ...settings })),
  };
  const extract = {
    extract: vi.fn(async (_input: unknown) => ({
      data: { price: 12 },
      title: "Price",
      url: "https://example.com",
      model: "spark",
      usage: { total_tokens: 5 },
    })),
  };
  const extensions = {
    installFromUrl: vi.fn(async (name) => ({
      name,
      title: "Test",
      version: "1.0",
      manifestVersion: 3,
      source: "library",
    })),
    install: vi.fn(async (name) => ({
      name,
      title: "Test",
      version: "1.0",
      manifestVersion: 3,
      source: "library",
    })),
  };
  app.decorate("watcherService", watchers as never);
  app.decorate("extractService", extract as never);
  app.decorate("extensionService", extensions as never);
  app.decorate("audit", { log: vi.fn().mockResolvedValue(undefined) } as never);
  await app.register(extrasRoutes, { prefix: "/v1" });
  await app.ready();
  return { app, watchers, extract, extensions };
}

describe("extras HTTP contracts", () => {
  it("serializes validation and parser errors as actionable 400 responses", async () => {
    const { app } = await setup();
    const invalid = await app.inject({
      method: "POST",
      url: "/v1/extract",
      payload: { url: "https://example.com" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ success: false, code: "invalid_request" });
    const malformed = await app.inject({
      method: "POST",
      url: "/v1/extract",
      headers: { "content-type": "application/json" },
      payload: "{",
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ success: false, code: "invalid_request" });
  });
  it("preserves omitted watcher settings on PATCH instead of applying creation defaults", async () => {
    const { app, watchers } = await setup();
    const response = await app.inject({
      method: "PATCH",
      url: `/v1/watchers/${id}`,
      payload: { name: "New name", notify: { cooldownMinutes: 20 } },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(watchers.update.mock.calls[0][1]).toMatchObject({
      name: "New name",
      enabled: false,
      intervalMinutes: 120,
      condition: { type: "lt", value: 10 },
      notify: { cooldownMinutes: 20, onErrorAfter: 5 },
    });
  });
  it("passes schemas to extraction and serializes model data and usage", async () => {
    const { app, extract } = await setup();
    const response = await app.inject({
      method: "POST",
      url: "/v1/extract",
      payload: { url: "https://example.com", schema: { type: "object" } },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ data: { price: 12 }, usage: { total_tokens: 5 } });
    expect(extract.extract.mock.calls[0][0]).toMatchObject({ schema: { type: "object" } });
  });
  it("accepts JSON extension URLs and multipart archives through the same endpoint", async () => {
    const { app, extensions } = await setup();
    const json = await app.inject({
      method: "POST",
      url: "/v1/extensions",
      payload: { name: "test", url: "https://example.com/extension.zip" },
    });
    expect(json.statusCode, json.body).toBe(200);
    expect(extensions.installFromUrl).toHaveBeenCalledWith(
      "test",
      "https://example.com/extension.zip",
    );
    const boundary = "steel-extras-test";
    const payload = `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\ntest\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.zip"\r\nContent-Type: application/zip\r\n\r\narchive\r\n--${boundary}--\r\n`;
    const upload = await app.inject({
      method: "POST",
      url: "/v1/extensions",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(upload.statusCode, upload.body).toBe(200);
    expect(extensions.install).toHaveBeenCalledWith("test", Buffer.from("archive"));
  });
});
