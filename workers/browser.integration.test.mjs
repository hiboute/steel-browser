import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PlaywrightAdapter } from "./adapters.mjs";
import { BrowserWorker } from "./worker.mjs";

for (const engine of (process.env.STEEL_TEST_ENGINES ?? "").split(",").filter(Boolean)) test(`${engine} real worker navigation, input, screenshots and checkpoint branch`, { timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "steel-worker-test-"));
  const fixture = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end('<title>Worker fixture</title><input id="name"><button>Apply</button><p id="result"></p><script>document.querySelector("button").onclick=()=>{document.querySelector("#result").textContent=document.querySelector("#name").value}</script>'); });
  await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve)); const url = `http://127.0.0.1:${fixture.address().port}/`;
  const adapter = new PlaywrightAdapter(engine, { profileRoot: root, executablePath: engine === "chromium" ? process.env.STEEL_TEST_CHROME_PATH : undefined }); const branch = new PlaywrightAdapter(engine, { profileRoot: root, executablePath: engine === "chromium" ? process.env.STEEL_TEST_CHROME_PATH : undefined });
  try {
    await adapter.launch(randomUUID(), { headless: true }); const navigation = await adapter.execute("goto", { url }); assert.equal(navigation.title, "Worker fixture");
    await adapter.execute("fill", { selector: "#name", value: "Steel verified" }); await adapter.execute("click", { selector: "button" });
    assert.match((await adapter.execute("snapshot", {})).text, /Steel verified/);
    await adapter.execute("evaluate", { expression: "localStorage.setItem('persist','yes'); sessionStorage.setItem('tab','saved'); document.cookie='test=1'" });
    const screenshot = await adapter.execute("screenshot", {}); assert.equal(Buffer.from(screenshot.data, "base64").subarray(1, 4).toString(), "PNG");
    const checkpoint = await adapter.execute("checkpoint", {}); await branch.launch(randomUUID(), { headless: true, checkpoint });
    assert.deepEqual(await branch.execute("evaluate", { expression: "({local:localStorage.getItem('persist'),session:sessionStorage.getItem('tab'),cookie:document.cookie})" }), { local: "yes", session: "saved", cookie: "test=1" });
    await branch.execute("evaluate", { expression: "localStorage.setItem('persist','branch')" }); assert.equal(await adapter.execute("evaluate", { expression: "localStorage.getItem('persist')" }), "yes");
  } finally { await adapter.close(); await branch.close(); await new Promise(resolve => fixture.close(resolve)); await rm(root, { recursive: true, force: true }); }
});

test("real Chromium outage shutdown aborts a pending evaluate without a successful result", { skip: !(process.env.STEEL_TEST_ENGINES ?? "").split(",").includes("chromium"), timeout: 20_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "steel-worker-shutdown-"));
  const adapter = new PlaywrightAdapter("chromium", { profileRoot: root, executablePath: process.env.STEEL_TEST_CHROME_PATH });
  const worker = new BrowserWorker({}); worker.credentials = { generation: 1 };
  try {
    await adapter.launch("shutdown-test", { headless: true }); worker.sessions.set("s", adapter);
    const pending = worker.execute({ id: "pending", sessionId: "s", generation: 1, kind: "evaluate", payload: { expression: "window.__pendingStarted=true; new Promise(()=>{})" } }); worker.running.set("pending", pending);
    await adapter.page.waitForFunction("window.__pendingStarted === true");
    await worker.close(); assert.equal(worker.sessions.size, 0); assert(worker.results.get("pending").error, "Aborted command must not report success"); assert.equal(worker.results.get("pending").result, undefined);
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});
