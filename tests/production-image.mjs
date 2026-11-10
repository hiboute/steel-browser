/** Executed inside the exact immutable API image, using its browser and runtime dependencies. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
const require = createRequire("/app/api/package.json");
const puppeteer = require("puppeteer-core").default;
const { withNavigationPolicy } = await import("/app/api/build/services/navigation-policy.js");
const root = await mkdtemp(path.join(os.tmpdir(), "steel-production-image-"));
const token = "production-image-fixture-credential-only";
const agentToken = "production-image-agent-credential-only";
const checks = [];
const evidence = { schemaVersion: 1, revision: process.env.STEEL_BUILD_REVISION, checkedAt: new Date().toISOString(), passed: false, checks, identities: [] };
let submitted = 0;
const fixture = createServer((req, res) => {
  if (req.url === "/submit" && req.method === "POST") { submitted++; res.end("Saved"); return; }
  res.setHeader("content-type", "text/html");
  res.end('<title>Exact image fixture</title><h1>Production runtime verified</h1><input id="value"><button id="save">Save</button><p id="result"></p><button id="submit">Submit reviewed action</button><p id="receipt"></p><script>document.querySelector("#save").onclick=()=>{document.querySelector("#result").textContent=document.querySelector("#value").value;localStorage.setItem("saved",document.querySelector("#value").value)};document.querySelector("#submit").onclick=()=>fetch("/submit",{method:"POST"}).then(r=>r.text()).then(t=>document.querySelector("#receipt").textContent=t)</script>');
});
await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`;
let browser, api;
const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
const call = async (route, method = "GET", body, extraHeaders = {}) => {
  const requestHeaders = { ...headers, ...extraHeaders }; if (body === undefined) delete requestHeaders["content-type"];
  const r = await fetch(`http://127.0.0.1:3300${route}`, { method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45_000) }); const data = await r.json(); assert(r.ok, `${method} ${route}: ${r.status} ${JSON.stringify(data)}`); return data;
};
try {
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_BIN ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const actualVersion = await browser.version(); evidence.browserVersion = actualVersion; assert.match(actualVersion, /Chrome\/\d+/); const page = await browser.newPage();
  await page.goto(fixtureUrl); assert.equal(await page.title(), "Exact image fixture"); await page.type("#value", "receipt verified"); await page.click("#save"); assert.equal(await page.$eval("#result", e => e.textContent), "receipt verified"); checks.push("browser navigation/input/outcome");
  assert((await page.screenshot()).length > 500); checks.push("real renderer screenshot");
  const createSession = page.createCDPSession.bind(page); let http2Seen = false;
  page.createCDPSession = async () => { const client = await createSession(); client.on("Fetch.requestPaused", event => { if (event.responseStatusCode !== undefined) { event.responseStatusText = ""; http2Seen = true; } }); return client; };
  await withNavigationPolicy(page, async () => { await page.goto(fixtureUrl); assert.equal(await page.$eval("h1", e => e.textContent), "Production runtime verified"); }, { allowPrivateNetworks: true }); assert(http2Seen); checks.push("HTTP2 empty reason phrase regression on production Chromium");
  await browser.close(); browser = undefined;
  api = spawn(process.execPath, ["api/build/index.js"], { cwd: "/app", stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, PORT: "3300", HOST: "127.0.0.1", NODE_ENV: "production", DISABLE_CHROME_SANDBOX: "true", MAX_SESSIONS: "2", ENABLE_COMMANDS_API: "true", MIN_FREE_MEMORY_MB: "0", STEEL_DATA_DIR: path.join(root, "data"), BROWSER_PROFILES_DIR: path.join(root, "profiles"), COOKIE_LIBRARY_DIR: path.join(root, "cookies"), CHROME_USER_DATA_DIR: path.join(root, "chrome"), STEEL_DATA_KEY: "fixture-data-key", STEEL_AUTH_KEYS: JSON.stringify({ [token]: { id: "image-test", role: "operator" }, [agentToken]: { id: "image-test-agent", role: "agent" } }), STEEL_BUILD_REVISION: process.env.STEEL_BUILD_REVISION ?? "unknown" } });
  let ready = false; for (let attempt = 0; attempt < 90; attempt++) { try { await call("/v1/sessions"); ready = true; break; } catch { if (api.exitCode !== null) throw new Error("Candidate API exited during startup"); await delay(500); } } assert(ready, "Candidate API starts"); checks.push("candidate API startup");
  const sessions = [];
  for (const mode of ["native", "compatible"]) {
    const created = await call("/v1/sessions", "POST", { headless: true, compatibilityMode: mode }); const id = created.id ?? created.session?.id; assert(id, "Session creation returns id"); sessions.push(id);
    const owned = await call(`/v1/sessions/${id}/control/acquire`, "POST", { mode: "agent", ttlMs: 120000 }); const lease = owned.token; assert(lease, "Control lease issued");
    const identity = await call(`/v1/sessions/${id}/identity`); evidence.identities.push({ mode, browserVersion: identity.browserVersion, userAgent: identity.observed.values?.userAgent, collector: identity.collector, issues: identity.issues }); assert.match(identity.browserVersion, /\d+/); assert.equal(identity.observed.status, "measured"); assert(!identity.issues.some(i => i.severity === "error"), JSON.stringify({ mode, actual: identity.browserVersion, userAgent: identity.observed.values?.userAgent, issues: identity.issues }));
    const lab = await call("/v1/compatibility/runs", "POST", { sessionId: id }, { "x-steel-control": lease }); assert(!lab.checks.some(c => c.status === "fail"), JSON.stringify(lab.checks)); checks.push(`${mode} identity and compatibility fixtures`);
    await call(`/v1/sessions/${id}/release`, "POST", {}, { "x-steel-control": lease });
  }
  const agentHeaders = { authorization: `Bearer ${agentToken}` };
  const procedure = await call("/v1/procedures", "POST", { name: "Exact image reviewed submission", steps: [
    { id: "open", kind: "commands", input: { commands: [{ command: "navigate", url: fixtureUrl }] } },
    { id: "submit", kind: "commands", input: { commands: [{ command: "click", target: "#submit" }] }, review: { summary: "Submit owned fixture", destination: fixtureUrl + "submit", fields: {}, attachments: [] } },
    { id: "wait", kind: "commands", input: { commands: [{ command: "wait", text: "Saved" }] } },
    { id: "verify", kind: "assert", assertion: { id: "saved", label: "Actual saved marker", command: { command: "get", what: "text", target: "#receipt" }, operator: "equals", expected: "Saved", evidence: "screenshot" } },
  ] }, agentHeaders);
  const run = await call(`/v1/procedures/${procedure.id}/run`, "POST", { version: 1, inputs: {}, idempotencyKey: "exact-image-reviewed-save", sessionOptions: { headless: true, compatibilityMode: "native" } }, agentHeaders);
  const untilRun = async (status) => {
    let observed;
    for (let attempt = 0; attempt < 120; attempt++) {
      observed = await call(`/v1/runs/${run.id}`, "GET", undefined, agentHeaders);
      if (observed.status === status) return observed;
      assert(!["failed", "uncertain", "cancelled"].includes(observed.status), JSON.stringify(observed));
      await delay(250);
    }
    assert.fail(`Run did not become ${status}: ${JSON.stringify(observed)}`);
  };
  const paused = await untilRun("paused"); assert.equal(paused.pauseReason, "review_required"); assert.equal(submitted, 0, "No submission before human approval");
  const review = (await call("/v1/reviews", "GET", undefined, agentHeaders)).reviews.find(row => row.runId === run.id); assert(review, "Paused run has a review");
  const decision = { decision: "approve", contentHash: review.contentHash };
  const denied = await fetch(`http://127.0.0.1:3300/v1/reviews/${review.id}/decision`, { method: "POST", headers: { ...headers, ...agentHeaders }, body: JSON.stringify(decision), signal: AbortSignal.timeout(10_000) }); assert.equal(denied.status, 403, "Agent cannot approve its own submission"); assert.equal(submitted, 0);
  await call(`/v1/reviews/${review.id}/decision`, "POST", decision);
  const completed = await untilRun("completed"); assert.equal(submitted, 1, "Approved action executes exactly once");
  const receipt = await call(`/v1/receipts/${run.id}`, "GET", undefined, agentHeaders); assert.equal(receipt.status, "verified"); assert.equal(receipt.assertions[0].actual, "Saved"); assert(receipt.assertions[0].evidence?.artifactId, "Verified receipt has actual screenshot evidence");
  evidence.procedure = { status: completed.status, receipt: receipt.status, submitted, agentApprovalDenied: true }; checks.push("durable reviewed procedure, agent approval denial and verified outcome evidence");
  const cleanupLease = await call(`/v1/sessions/${completed.sessionId}/control/acquire`, "POST", { mode: "agent", ttlMs: 120000 });
  await call(`/v1/sessions/${completed.sessionId}/release`, "POST", {}, { "x-steel-control": cleanupLease.token }); await call(`/v1/procedures/${procedure.id}`, "DELETE");
  const report = { ...evidence, browserVersion: actualVersion, checks, passed: true, testedAt: new Date().toISOString() };
  await writeFile(process.env.STEEL_IMAGE_REPORT ?? "/tmp/production-image-report.json", JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
  await writeFile(process.env.STEEL_IMAGE_REPORT ?? "/tmp/production-image-report.json", JSON.stringify({ ...evidence, error: String(error.message).slice(0, 5000) }, null, 2)); throw error;
} finally {
  await browser?.close(); if (api && api.exitCode === null) { api.kill("SIGTERM"); await Promise.race([new Promise(resolve => api.once("exit", resolve)), delay(40_000).then(() => api.kill("SIGKILL"))]); }
  await new Promise(resolve => fixture.close(resolve)); await rm(root, { recursive: true, force: true });
}
