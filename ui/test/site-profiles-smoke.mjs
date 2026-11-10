import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Use an isolated API. Never point this fixture suite at a production workspace.
const api = process.env.API_TEST_BASE_URL || "http://127.0.0.1:3348";
const base = process.env.UI_TEST_BASE_URL || "http://127.0.0.1:5178";
const site = process.env.UI_TEST_FIXTURE_URL || "http://127.0.0.1:3349";
const operator = process.env.UI_TEST_OPERATOR_KEY;
if (!operator) throw new Error("Set UI_TEST_OPERATOR_KEY for an operator in the isolated API");
const artifacts = process.env.UI_TEST_ARTIFACT_DIR || join(tmpdir(), "steel-site-profiles-smoke");
await mkdir(artifacts, { recursive: true });
const tag = Date.now().toString(36),
  leases = new Map();
const reports = [],
  errors = [];
async function request(
  path,
  body,
  method = body === undefined ? "GET" : "POST",
  key = operator,
  expected = 200,
) {
  const sessionId = /\/sessions\/([^/]+)/.exec(path)?.[1] || body?.sessionId;
  const response = await fetch(api + path, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(leases.has(sessionId) ? { "X-Steel-Control": leases.get(sessionId) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = text;
  }
  assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(value)}`);
  return value;
}
async function wait(fn, label = "state", timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function take(id) {
  const { lease } = await request(`/v1/sessions/${id}/control`);
  const value = await request(`/v1/sessions/${id}/control/${lease ? "transfer" : "acquire"}`, {
    mode: "human",
    ttlMs: 300000,
  });
  leases.set(id, value.token);
  return value;
}
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_EXECUTABLE_PATH || "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });
await page.setExtraHTTPHeaders({ Authorization: `Bearer ${operator}` });
page.on("pageerror", (error) => errors.push({ url: page.url(), stack: error.stack }));
page.on("response", (response) => {
  if (response.status() >= 500 && response.url().startsWith(base))
    errors.push({ url: response.url().replace(/\?.*/, ""), status: response.status() });
  if (/\/control\/(acquire|transfer)$/.test(response.url()) && response.ok())
    void response
      .json()
      .then((value) => leases.set(value.lease.sessionId, value.token))
      .catch(() => {});
});
async function click(text, selector = "button", scope) {
  await page.waitForFunction(
    (t, s, c) => {
      const root = c ? document.querySelector(c) : document;
      const button = [...(root?.querySelectorAll(s) || [])].find(
        (element) =>
          element.textContent.trim() === t && !element.disabled && element.getClientRects().length,
      );
      if (!button) return false;
      button.click();
      return true;
    },
    {},
    text,
    selector,
    scope,
  );
}
async function field(selector, value) {
  await page.waitForSelector(selector);
  await page.$eval(
    selector,
    (element, value) => {
      element.value = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    },
    String(value),
  );
}
async function nav(name) {
  await click(name, ".rail-item-label");
}
async function shot(name) {
  await page.screenshot({ path: join(artifacts, `${name}.png`), fullPage: true });
}
async function check(name, fn) {
  await fn();
  reports.push({ name, passed: true });
  console.log(`PASS ${name}`);
}
let id;
const name = `ui-site-${tag}`,
  origin = new URL(site).origin;
const profilePath = `/v1/site-profiles/${name}`;
async function cardButton(label) {
  await page.waitForFunction(
    (name, label) => {
      const card = [...document.querySelectorAll(".resource-card")].find(
        (el) => el.querySelector("h2")?.textContent === name,
      );
      const button = [...(card?.querySelectorAll("button") || [])].find(
        (el) => el.textContent.trim() === label && !el.disabled,
      );
      if (!button) return false;
      button.click();
      return true;
    },
    {},
    name,
    label,
  );
}
async function saveStatus(status) {
  const response = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api${profilePath}` &&
      response.request().method() === "PUT",
  );
  await click("Save", "button", "dialog[open]");
  assert.equal((await response).status(), status);
}
try {
  await wait(
    () =>
      fetch(`${api}/v1/health`)
        .then((r) => r.ok)
        .catch(() => false),
    "API startup",
  );
  const session = await request("/v1/sessions", {
    name: `Site profile UI ${tag}`,
    idleTimeout: 0,
    timeout: 300000,
  });
  id = session.id;
  await page.goto(`${base}/?session=${id}`, { waitUntil: "networkidle0" });
  await click("Take control");
  await wait(() => leases.has(id), "human lease");
  await nav("Identity & compatibility");
  await click("Site profiles");
  await check("site editor validates exact origin and creates a persisted profile", async () => {
    await click("New site profile");
    await field('dialog[open] [name="name"]', name);
    await field('dialog[open] [name="origin"]', `${origin}/not-an-origin`);
    await field(
      'dialog[open] [name="settings"]',
      JSON.stringify({ compatibilityMode: "native", timezone: "UTC", locale: "en-US" }),
    );
    await saveStatus(400);
    await page.waitForFunction(() => !!document.querySelector('dialog[open] [role="alert"]'));
    await field('dialog[open] [name="origin"]', origin);
    await saveStatus(200);
    await page.waitForFunction(() => !document.querySelector("dialog[open]"));
    const saved = await request(profilePath);
    assert.equal(saved.revision, 1);
    assert.equal(saved.origin, origin);
    assert.equal(saved.settings.locale, "en-US");
    await shot("01-created-site-profile");
  });
  await check("site editor updates settings and revision", async () => {
    await cardButton("Edit");
    await field(
      'dialog[open] [name="settings"]',
      JSON.stringify({ compatibilityMode: "native", timezone: "UTC", locale: "fr-FR" }),
    );
    await field(
      'dialog[open] [name="interaction"]',
      JSON.stringify({ frictionDetection: true, actionDelayMs: 100 }),
    );
    await saveStatus(200);
    const updated = await request(profilePath);
    assert.equal(updated.revision, 2);
    assert.equal(updated.settings.locale, "fr-FR");
    assert.equal(updated.interaction.actionDelayMs, 100);
  });
  await check(
    "site success action shows an exact-origin conflict and succeeds on its own origin",
    async () => {
      const mismatch = page.waitForResponse(
        (r) => r.url().endsWith(`${profilePath}/success`) && r.request().method() === "POST",
      );
      await cardButton("Record current success");
      assert.equal((await mismatch).status(), 409);
      await page.waitForFunction(() =>
        document.body.textContent.includes("Current page is outside this site profile"),
      );
      await shot("02-origin-conflict");
      const navigated = await request(`/v1/sessions/${id}/commands`, {
        commands: [{ command: "navigate", url: site }],
      });
      assert(navigated.results.every((result) => result.ok));
      const successful = page.waitForResponse(
        (r) => r.url().endsWith(`${profilePath}/success`) && r.request().method() === "POST",
      );
      await cardButton("Record current success");
      assert.equal((await successful).status(), 200);
      assert((await request(profilePath)).lastSuccessfulAt);
    },
  );
  await check(
    "stale site edit remains open with conflict feedback and preserves the newer version",
    async () => {
      await cardButton("Edit");
      await request(
        profilePath,
        {
          expectedRevision: 2,
          origin,
          settings: { compatibilityMode: "native", timezone: "UTC", locale: "de-DE" },
          interaction: { frictionDetection: true, actionDelayMs: 200 },
        },
        "PUT",
      );
      await field(
        'dialog[open] [name="settings"]',
        JSON.stringify({ compatibilityMode: "native", timezone: "UTC", locale: "es-ES" }),
      );
      await saveStatus(409);
      await page.waitForFunction(() =>
        document
          .querySelector("dialog[open]")
          ?.textContent.includes("Pass expectedRevision to update site profile"),
      );
      assert.equal((await request(profilePath)).settings.locale, "de-DE");
      await shot("03-revision-conflict");
      await click("Cancel", "button", "dialog[open]");
      await page.waitForFunction(
        (name) =>
          [...document.querySelectorAll(".resource-card")].some(
            (card) =>
              card.querySelector("h2")?.textContent === name &&
              card.textContent.includes("revision 3"),
          ),
        {},
        name,
      );
      await cardButton("Edit");
      await field(
        'dialog[open] [name="settings"]',
        JSON.stringify({ compatibilityMode: "native", timezone: "UTC", locale: "it-IT" }),
      );
      await saveStatus(200);
      assert.equal((await request(profilePath)).revision, 4);
    },
  );
  await check(
    "new browser form reports explicit settings conflicting with a selected site profile",
    async () => {
      await page.click('button[data-shortcut="s"]');
      await page.waitForFunction(
        (name) =>
          [...document.querySelectorAll('dialog[open] select[name="siteProfile"] option')].some(
            (option) => option.value === name,
          ),
        {},
        name,
      );
      await page.select('dialog[open] [name="siteProfile"]', name);
      await page.select('dialog[open] [name="compatibilityMode"]', "compatible");
      const failed = page.waitForResponse(
        (r) => new URL(r.url()).pathname === "/api/v1/sessions" && r.request().method() === "POST",
      );
      await click("Start session", "button", "dialog[open]");
      assert.equal((await failed).status(), 409);
      await page.waitForFunction(() =>
        document
          .querySelector("dialog[open]")
          ?.textContent.includes("conflicts with explicit options"),
      );
      await shot("04-launch-conflict");
      await click("Cancel", "button", "dialog[open]");
    },
  );
  await check("site profile deletes from Workshop and the API", async () => {
    const removed = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === `/api${profilePath}` && r.request().method() === "DELETE",
    );
    await cardButton("Delete");
    assert.equal((await removed).status(), 200);
    await request(profilePath, undefined, "GET", operator, 404);
    await page.waitForFunction(
      (name) =>
        ![...document.querySelectorAll(".resource-card h2")].some((el) => el.textContent === name),
      {},
      name,
    );
    await shot("05-deleted-site-profile");
  });
  assert.deepEqual(errors, []);
} catch (error) {
  await shot("failure").catch(() => {});
  throw error;
} finally {
  await browser.close();
  const cleanup = [];
  const profile = await request("/v1/site-profiles");
  if (profile.profiles.some((p) => p.name === name))
    await request(profilePath, undefined, "DELETE");
  if (id) {
    await take(id);
    await request(`/v1/sessions/${id}/release`, {});
  }
  await writeFile(
    join(artifacts, "results.json"),
    JSON.stringify({ reports, errors, cleanup }, null, 2),
  );
}
