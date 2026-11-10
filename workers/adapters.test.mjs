import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { SafariAdapter, validatePayload } from "./adapters.mjs";
import { BrowserWorker } from "./worker.mjs";
test("worker rejects unsafe navigation and bounds input", () => {
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "https://user:password@example.org", "about:config"]) assert.throws(() => validatePayload("goto", { url }));
  assert.doesNotThrow(() => validatePayload("goto", { url: "https://example.org" }));
  assert.throws(() => validatePayload("fill", { selector: "input", value: "x".repeat(100001) }));
});
test("Safari adapter uses WebDriver and distinguishes unsupported capabilities", async () => {
  const calls = []; const server = createServer(async (req, res) => { let raw = ""; for await (const chunk of req) raw += chunk; calls.push({ method: req.method, path: req.url, body: raw ? JSON.parse(raw) : undefined }); res.setHeader("content-type", "application/json"); let value = null; if (req.url === "/session") value = { sessionId: "safari-test", capabilities: { browserVersion: "26" } }; if (req.url.endsWith("/title")) value = "Fixture"; if (req.url.endsWith("/url") && req.method === "GET") value = "https://example.org/"; res.end(JSON.stringify({ value })); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const adapter = new SafariAdapter({ allowTestHost: true, webdriverUrl: `http://127.0.0.1:${server.address().port}` });
  try { await assert.rejects(adapter.launch("s", { headless: true }), /headless_unsupported/); const launched = await adapter.launch("s", { headless: false }); assert.equal(launched.engine, "safari"); const result = await adapter.execute("goto", { url: "https://example.org" }); assert.equal(result.title, "Fixture"); await assert.rejects(adapter.execute("unsupported", {}), /unsupported_capability/); await adapter.close(); assert(calls.some(c => c.method === "DELETE")); } finally { await new Promise(resolve => server.close(resolve)); }
});
test("worker fences stale generations and sanitizes errors containing typed secrets", async () => {
  const worker = new BrowserWorker({ capabilities: { capacity: 1, engines: ["chromium"], strictEgress: false }, adapterFactory: () => ({ launch: async () => { throw new Error("Failed to fill password SUPERSECRET at https://secret.example/"); }, close: async () => {} }) }); worker.credentials = { generation: 2 };
  await worker.execute({ id: "stale", sessionId: "s", generation: 1, kind: "launch", payload: { engine: "chromium" } }); assert.equal(worker.results.get("stale").error, "stale_worker_generation");
  await worker.execute({ id: "new", sessionId: "s", generation: 2, kind: "launch", payload: { engine: "chromium" } }); assert.equal(worker.results.get("new").error, "browser_command_failed"); assert(!JSON.stringify([...worker.results]).includes("SUPERSECRET"));
});
