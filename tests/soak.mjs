/**
 * Long-running check of the exact API image: the same short browser job over and
 * over for SOAK_MINUTES, watching for what only shows with time: memory that
 * keeps growing, pages or browsers left behind, sessions that never end.
 * Runs inside the image like production-image.mjs. Exit code 1 means a leak or
 * too many failed cycles; the JSON report says which.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const minutes = Number(process.env.SOAK_MINUTES ?? 1440);
const pauseMs = Number(process.env.SOAK_PAUSE_MS ?? 20_000);
const appRoot = process.env.SOAK_APP_ROOT ?? "/app";
const port = Number(process.env.SOAK_PORT ?? 3310);
const root = await mkdtemp(path.join(os.tmpdir(), "steel-soak-"));
const token = "soak-fixture-credential-only-0123456789";
const MB = 1048576;

const fixture = createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end('<title>Soak fixture</title><input id="value"><button id="save">Save</button><p id="result"></p><script>document.querySelector("#save").onclick=()=>{const v=document.querySelector("#value").value;localStorage.setItem("saved",v);document.querySelector("#result").textContent="Saved "+v}</script>');
});
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`;

const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
const call = async (route, method = "GET", body, extra = {}) => {
  const h = { ...headers, ...extra };
  if (body === undefined) delete h["content-type"];
  const r = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  const data = await r.json().catch(() => ({}));
  assert(r.ok, `${method} ${route}: ${r.status} ${JSON.stringify(data).slice(0, 300)}`);
  return data;
};
const median = (values) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

const api = spawn(process.execPath, ["api/build/index.js"], {
  cwd: appRoot,
  stdio: ["ignore", "ignore", "pipe"],
  env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", NODE_ENV: "production", DISABLE_CHROME_SANDBOX: "true", CHROME_HEADLESS: "true", MAX_SESSIONS: "2", ENABLE_COMMANDS_API: "true", MIN_FREE_MEMORY_MB: "0", SESSION_EXPIRE_ACTION: "park", STEEL_DATA_DIR: path.join(root, "data"), BROWSER_PROFILES_DIR: path.join(root, "profiles"), COOKIE_LIBRARY_DIR: path.join(root, "cookies"), CHROME_USER_DATA_DIR: path.join(root, "chrome"), STEEL_DATA_KEY: "soak-data-key", STEEL_AUTH_KEYS: JSON.stringify({ [token]: { id: "soak", role: "operator" } }) },
});
let stderr = "";
api.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
const apiRss = async () => Number((await readFile(`/proc/${api.pid}/status`, "utf8")).match(/VmRSS:\s+(\d+)/)?.[1] ?? 0) * 1024;
const sample = async (cycle) => {
  const pool = await call("/v1/pool");
  return { cycle, at: new Date().toISOString(), apiRss: await apiRss(), chromeRss: pool.slots.reduce((sum, s) => sum + (s.rssBytes ?? 0), 0), pages: pool.slots.reduce((sum, s) => sum + (s.pages ?? 0), 0), live: pool.live, parked: pool.parked ?? 0 };
};

const report = { schemaVersion: 1, revision: process.env.STEEL_BUILD_REVISION, minutes, startedAt: new Date().toISOString(), cycles: 0, failed: 0, failures: [], samples: [], problems: [], passed: false };
let exitCode = 1;
try {
  let ready = false;
  for (let attempt = 0; attempt < 120 && !ready; attempt++) {
    try { await call("/v1/sessions"); ready = true; } catch { assert(api.exitCode === null, "The API exited during startup: " + stderr.slice(-500)); await delay(500); }
  }
  assert(ready, "The API did not start");
  const idleStart = await sample(0);
  report.samples.push(idleStart);
  const end = Date.now() + minutes * 60_000;
  const sampleEvery = Math.max(1, Math.round(60_000 / Math.max(pauseMs, 1000)));
  while (Date.now() < end) {
    const cycle = ++report.cycles;
    let id, lease;
    try {
      const created = await call("/v1/sessions", "POST", { headless: true });
      id = created.id;
      lease = (await call(`/v1/sessions/${id}/control/acquire`, "POST", { mode: "agent", ttlMs: 180_000 })).token;
      const control = { "x-steel-control": lease };
      const run = await call(`/v1/sessions/${id}/commands`, "POST", { commands: [{ command: "navigate", url: fixtureUrl }, { command: "fill", target: "#value", value: `cycle ${cycle}` }, { command: "click", target: "#save" }, { command: "wait", text: `Saved cycle ${cycle}` }] }, control);
      assert.equal(run.execution?.state, "completed", JSON.stringify(run).slice(0, 400));
      if (cycle % 5 === 0) {
        // Park and resume: the state has to come back, and the slot has to be freed in between.
        await call(`/v1/sessions/${id}/park`, "POST", {}, control);
        lease = (await call(`/v1/sessions/${id}/control/acquire`, "POST", { mode: "agent", ttlMs: 180_000 })).token;
        await call(`/v1/sessions/${id}/resume`, "POST", {}, { "x-steel-control": lease });
        const kept = await call(`/v1/sessions/${id}/commands`, "POST", { commands: [{ command: "eval", script: "localStorage.getItem('saved')" }] }, { "x-steel-control": lease });
        assert(JSON.stringify(kept).includes(`cycle ${cycle}`), "State lost over park and resume: " + JSON.stringify(kept).slice(0, 300));
      }
    } catch (error) {
      report.failed++;
      if (report.failures.length < 20) report.failures.push({ cycle, error: String(error?.message ?? error).slice(0, 400) });
    } finally {
      if (id) await call(`/v1/sessions/${id}/release`, "POST", {}, lease ? { "x-steel-control": lease } : {}).catch(() => {});
    }
    if (api.exitCode !== null) throw new Error("The API exited during the soak: " + stderr.slice(-500));
    if (cycle % sampleEvery === 0) report.samples.push(await sample(cycle).catch(() => report.samples.at(-1)));
    await delay(pauseMs);
  }
  await delay(5000);
  const idleEnd = await sample(report.cycles);
  report.samples.push(idleEnd);
  const body = report.samples.slice(Math.ceil(report.samples.length * 0.1));
  const quarter = Math.max(1, Math.floor(body.length / 4));
  const early = median(body.slice(0, quarter).map((s) => s.apiRss)), late = median(body.slice(-quarter).map((s) => s.apiRss));
  report.summary = { cycles: report.cycles, failed: report.failed, apiRssEarlyMB: Math.round(early / MB), apiRssLateMB: Math.round(late / MB), chromeIdleStartMB: Math.round(idleStart.chromeRss / MB), chromeIdleEndMB: Math.round(idleEnd.chromeRss / MB), idlePagesStart: idleStart.pages, idlePagesEnd: idleEnd.pages };
  if (!report.cycles) report.problems.push("No cycle ran");
  if (report.failed > Math.max(1, report.cycles * 0.02)) report.problems.push(`${report.failed} of ${report.cycles} cycles failed`);
  if (late > early * 1.5 + 100 * MB) report.problems.push(`API memory kept growing: ${report.summary.apiRssEarlyMB} MB early, ${report.summary.apiRssLateMB} MB late`);
  if (idleEnd.chromeRss > idleStart.chromeRss * 2 + 300 * MB) report.problems.push(`Idle browser memory grew from ${report.summary.chromeIdleStartMB} to ${report.summary.chromeIdleEndMB} MB`);
  if (idleEnd.pages > idleStart.pages + 2) report.problems.push(`Pages left open: ${idleStart.pages} at the start, ${idleEnd.pages} at the end`);
  if (idleEnd.live || idleEnd.parked) report.problems.push(`Sessions left behind: ${idleEnd.live} live, ${idleEnd.parked} parked`);
  report.passed = report.problems.length === 0;
  exitCode = report.passed ? 0 : 1;
} catch (error) {
  report.problems.push(String(error?.message ?? error).slice(0, 600));
} finally {
  report.endedAt = new Date().toISOString();
  // Keep the report small: at most 200 evenly spaced samples.
  const step = Math.ceil(report.samples.length / 200);
  report.samples = report.samples.filter((_, i) => i % step === 0 || i === report.samples.length - 1);
  await writeFile(process.env.SOAK_REPORT ?? "/tmp/steel-soak-report.json", JSON.stringify(report, null, 2)).catch(() => {});
  console.log(JSON.stringify({ passed: report.passed, problems: report.problems, summary: report.summary, failures: report.failures.slice(0, 5) }, null, 2));
  api.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => api.once("exit", resolve)), delay(30_000)]);
  fixture.close();
  await rm(root, { recursive: true, force: true }).catch(() => {});
  process.exit(exitCode);
}
