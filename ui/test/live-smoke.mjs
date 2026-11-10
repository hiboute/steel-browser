import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const base = process.env.UI_TEST_BASE_URL || "http://127.0.0.1:5174";
const api = process.env.API_TEST_BASE_URL || "http://127.0.0.1:3307";
const site = process.env.UI_TEST_FIXTURE_URL || "http://127.0.0.1:3347";
const cdpBase = (process.env.UI_TEST_CDP_URL || api.replace(/^http/, "ws")).replace(/\/$/, "");
const artifacts = process.env.UI_TEST_ARTIFACT_DIR || join(tmpdir(), "steel-ui-smoke");
await mkdir(artifacts, { recursive: true });
const runId = Date.now().toString(36),
  sessionName = `UI smoke ${runId}`,
  loginName = `ui-smoke-${runId}`,
  watcherName = `UI smoke ${runId}`,
  warmName = `ui-smoke-${runId}`;
const request = async (path, body, method = body === undefined ? "GET" : "POST") => {
  const response = await fetch(api + path, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      "X-Steel-Client": "ui",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(value)}`);
  return value;
};
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_EXECUTABLE_PATH || "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });
await page.evaluateOnNewDocument(() => {
  localStorage.setItem("steel-browser:console", "0");
  localStorage.setItem("steel-browser:rail", window.innerWidth > 900 ? "1" : "0");
});
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const click = async (text, selector = "button") => {
  await page.waitForFunction(
    (s, t) =>
      [...document.querySelectorAll(s)].some(
        (e) => e.textContent.trim() === t && !e.disabled && e.getClientRects().length,
      ),
    {},
    selector,
    text,
  );
  await page.evaluate(
    (s, t) =>
      [...document.querySelectorAll(s)]
        .find((e) => e.textContent.trim() === t && !e.disabled && e.getClientRects().length)
        .click(),
    selector,
    text,
  );
};
const nav = (name) => click(name, ".rail-item-label");
const wait = async (fn) => {
  for (let i = 0; i < 100; i++) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Timed out waiting for state");
};
let id, cdp, watcherId;
const rowClick = async (name, text, selector) => {
  await page.waitForFunction(
    (n, t, s) =>
      [...document.querySelectorAll(s)].some(
        (row) =>
          row.textContent.includes(n) &&
          [...row.querySelectorAll("button")].some(
            (button) => button.textContent.trim() === t && !button.disabled,
          ),
      ),
    {},
    name,
    text,
    selector,
  );
  await page.evaluate(
    (n, t, s) =>
      [...document.querySelectorAll(s)]
        .find((row) => row.textContent.includes(n))
        .querySelectorAll("button")
        .forEach((button) => {
          if (button.textContent.trim() === t) button.click();
        }),
    name,
    text,
    selector,
  );
};
const results = [];
try {
  await request("/v1/health");
  await page.goto(base, { waitUntil: "networkidle0" });
  await page.click('button[data-shortcut="s"]');
  await page.type("dialog[open] input[name=name]", sessionName);
  await page.select("dialog[open] select[name=egress]", "direct");
  await page.click("dialog[open] button[type=submit]");
  const session = await wait(async () => {
    const { sessions } = await request("/v1/sessions");
    return sessions.find((s) => s.name === sessionName && s.status === "live");
  });
  id = session.id;
  results.push("Session created through UI");
  cdp = await puppeteer.connect({ browserWSEndpoint: `${cdpBase}/v1/sessions/${id}/cdp` });
  const tab = (await cdp.pages())[0];
  await tab.goto(site, { waitUntil: "networkidle0" });
  await tab.click("button");
  await page.goto(`${base}/?session=${id}`, { waitUntil: "networkidle0" });
  await wait(async () => Boolean(await page.$("iframe.live-frame")));
  await request(`/v1/sessions/${id}/timeline`, {
    tool: "integration_check",
    kind: "action",
    title: "Prepared a browser with saved state",
    screenshot: true,
  });
  await request(`/v1/sessions/${id}/handoff`, {
    reason: "Verify the workshop page",
    instructions: "Confirm that the saved-state button says Saved.",
    notify: false,
  });
  await page.waitForSelector(".handoff-banner");
  await click("Done, continue");
  await wait(async () => (await request(`/v1/sessions/${id}/handoff`)).status === "done");
  results.push("Human handoff completed through UI");
  await click("Save cookies");
  await page.type("dialog[open] input[name=name]", loginName);
  await click("Save");
  await page.waitForFunction(
    (name) => document.querySelector("dialog[open]")?.textContent.includes(`Saved ${name}`),
    {},
    loginName,
  );
  await click("Done");
  results.push("Saved login captured through UI");
  await click("Replay");
  await click("Start recording");
  await tab.evaluate(() => (document.body.style.background = "#d1e5dc"));
  await wait(async () => (await request(`/v1/sessions/${id}/recording`)).frames > 0);
  await click("Stop recording");
  results.push("Recording start/frame capture/stop through UI");
  await tab.click('a[href="/download"]');
  await wait(async () => (await request(`/v1/sessions/${id}/files`)).data.length > 0);
  await click("Downloads");
  await page.waitForSelector(".file-list a");
  const download = await page.$eval(".file-list a", (el) => el.href);
  assert.equal((await fetch(download)).status, 200);
  results.push("Downloaded file listed and fetched through UI");
  await click("Park");
  await wait(async () => (await request(`/v1/sessions/${id}`)).status === "parked");
  cdp.disconnect();
  cdp = null;
  results.push("Session parked through UI");
  await page.waitForFunction(() => document.body.textContent.includes("Saved for later"));
  await page.screenshot({ path: join(artifacts, "parked.png"), fullPage: true });
  await click("Resume");
  await wait(async () => (await request(`/v1/sessions/${id}`)).status === "live");
  cdp = await puppeteer.connect({ browserWSEndpoint: `${cdpBase}/v1/sessions/${id}/cdp` });
  const restored = (await cdp.pages()).find((p) => p.url().startsWith(site));
  assert.ok(restored);
  assert.equal(await restored.evaluate(() => localStorage.getItem("test")), "saved");
  assert.ok((await restored.cookies()).some((c) => c.name === "workshop" && c.value === "yes"));
  results.push("Resume preserves cookie/localStorage identity");
  await nav("Saved logins");
  await rowClick(loginName, "Settings", "tbody tr");
  await page.$eval("dialog[open] input[name=url]", (el) => (el.value = ""));
  await page.type("dialog[open] input[name=url]", site + "/account");
  await page.$eval("dialog[open] input[name=loggedInSelector]", (el) => (el.value = ""));
  await page.type("dialog[open] input[name=loggedInSelector]", "#account");
  await click("Save settings");
  await page.waitForFunction(() => !document.querySelector("dialog[open]"));
  await rowClick(loginName, "Check", "tbody tr");
  await wait(
    async () =>
      (await request("/v1/cookie-library")).sets.find((s) => s.name === loginName)?.health
        .status === "ok",
  );
  results.push("Cookie login health check configured and run through UI");
  await nav("Page watchers");
  await click("Watch a page");
  await page.type("dialog[open] input[name=name]", watcherName);
  await page.type("dialog[open] input[name=url]", site);
  await page.type("dialog[open] input[name=selector]", ".price");
  await click("Save");
  const watcher = await wait(async () =>
    (await request("/v1/watchers")).watchers.find((w) => w.name === watcherName),
  );
  await wait(async () => (await request("/v1/pool")).background.running === 0);
  watcherId = watcher.id;
  await rowClick(watcherName, "Check now", ".resource-card");
  await wait(async () => (await request(`/v1/watchers/${watcher.id}/history`)).history.length > 0);
  results.push("Page watcher created and run through UI");
  await nav("Warm browsers");
  await click("Add warm browser");
  await page.type("dialog[open] input[name=name]", warmName);
  await page.type("dialog[open] input[name=url]", site);
  await click("Save");
  await wait(async () =>
    (await request("/v1/warm")).warm.some((w) => w.name === warmName && w.status === "live"),
  );
  results.push("Warm browser created and launched through UI");
  await nav("Extract");
  await page.type("input[name=sessionId]", id);
  await click("Extract data");
  await page.waitForFunction(() =>
    document.querySelector("pre")?.textContent.includes("Browser workshop"),
  );
  results.push("Structured extract through real API with local deterministic LLM responder");
  await nav("Browser pool");
  await page.screenshot({ path: join(artifacts, "pool.png"), fullPage: true });
  for (const name of ["Extensions", "Network", "Activity & notifications"]) {
    await nav(name);
    await page.waitForSelector(".workspace-page");
  }
  await page.goto(`${base}/?session=${id}`, { waitUntil: "networkidle0" });
  await page.screenshot({ path: join(artifacts, "session.png"), fullPage: true });
  await page.setViewport({ width: 390, height: 844 });
  await page.reload({ waitUntil: "networkidle0" });
  await page.click('button[aria-label="Expand sidebar"]');
  await nav("Browser pool");
  await page.waitForSelector(".stat-grid");
  assert.equal(await page.$('button[aria-label="Collapse sidebar"]'), null);
  await page.screenshot({ path: join(artifacts, "mobile.png"), fullPage: true });
  results.push("Mobile navigation opens and closes after selection");
  assert.deepEqual(errors, []);
  results.push("No browser runtime errors");
  console.log(JSON.stringify({ passed: results }, null, 2));
  await writeFile(join(artifacts, "results.json"), JSON.stringify({ passed: results }, null, 2));
} catch (error) {
  console.error("Completed before failure:", results);
  console.error(error);
  await page.screenshot({ path: join(artifacts, "failure.png"), fullPage: true }).catch(() => {});
  throw error;
} finally {
  cdp?.disconnect();
  await browser.close();
  const cleanup = [];
  const remove = async (path, method = "DELETE") => {
    try {
      await request(path, undefined, method);
    } catch (error) {
      cleanup.push(error.message);
    }
  };
  // Only delete names/IDs allocated by this invocation, including failed runs.
  const warm = (await request("/v1/warm").catch(() => ({ warm: [] }))).warm.find(
    (w) => w.name === warmName,
  );
  if (warm) await remove("/v1/warm/" + encodeURIComponent(warmName));
  if (!watcherId)
    watcherId = (await request("/v1/watchers").catch(() => ({ watchers: [] }))).watchers.find(
      (w) => w.name === watcherName,
    )?.id;
  if (watcherId) await remove("/v1/watchers/" + encodeURIComponent(watcherId));
  if (id) await remove(`/v1/sessions/${id}/release`, "POST");
  const login = (await request("/v1/cookie-library").catch(() => ({ sets: [] }))).sets.find(
    (s) => s.name === loginName,
  );
  if (login) await remove("/v1/cookie-library/" + encodeURIComponent(loginName));
  if (cleanup.length) {
    console.error("Smoke resource cleanup failed:", cleanup);
    process.exitCode = 1;
  }
}
