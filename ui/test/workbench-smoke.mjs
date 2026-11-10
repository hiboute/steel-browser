import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Use an isolated API. Never point this fixture suite at a production workspace.
const api = process.env.API_TEST_BASE_URL || "http://127.0.0.1:3348";
const base = process.env.UI_TEST_BASE_URL || "http://127.0.0.1:5178";
const site = process.env.UI_TEST_FIXTURE_URL || "http://127.0.0.1:3349";
const operator = process.env.UI_TEST_OPERATOR_KEY,
  agent = process.env.UI_TEST_AGENT_KEY;
if (!operator || !agent)
  throw new Error(
    "Set UI_TEST_OPERATOR_KEY and UI_TEST_AGENT_KEY for two credentials of the same test principal",
  );
const artifacts = process.env.UI_TEST_ARTIFACT_DIR || join(tmpdir(), "steel-workbench-smoke");
await mkdir(artifacts, { recursive: true });
const tag = Date.now().toString(36),
  leases = new Map(),
  owned = {
    sessions: [],
    procedures: [],
    knowledge: [],
    snapshots: [],
    profiles: [],
    checkpoints: [],
  };
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
async function form(title, values, button) {
  const selector = `form[data-smoke-form]`;
  await page.waitForFunction(
    (t) =>
      [...document.querySelectorAll("form")].some((f) => f.querySelector("h2")?.textContent === t),
    {},
    title,
  );
  await page.evaluate((t) => {
    document
      .querySelectorAll("[data-smoke-form]")
      .forEach((element) => element.removeAttribute("data-smoke-form"));
    [...document.querySelectorAll("form")]
      .find((f) => f.querySelector("h2")?.textContent === t)
      .setAttribute("data-smoke-form", "");
  }, title);
  for (const [name, value] of Object.entries(values))
    await field(
      `${selector} [name="${name}"]`,
      typeof value === "string" ? value : JSON.stringify(value),
    );
  await click(button, "button", selector);
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
try {
  await request("/v1/health");
  const session = await request(
    "/v1/sessions",
    {
      name: `Workbench ${tag}`,
      idleTimeout: 0,
      timeout: 1800000,
      dimensions: { width: 1280, height: 800 },
    },
    "POST",
    agent,
  );
  id = session.id;
  owned.sessions.push(id);
  await page.goto(`${base}/?session=${id}`, { waitUntil: "networkidle0" });
  await check("observer by default, explicit control, live viewer navigation", async () => {
    await page.waitForFunction(() => document.body.textContent.includes("Observer"));
    await click("Take control");
    await wait(() => leases.has(id), "UI control lease");
    await page.waitForFunction(() => document.body.textContent.includes("You have control"));
    const frame = await wait(
      () => page.frames().find((frame) => frame.url().includes(`/sessions/${id}/debug`)),
      "live viewer",
    );
    await frame.waitForSelector("#url-text:not([disabled])");
    await frame.$eval(
      "#url-text",
      (input, url) => {
        input.value = url;
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }),
        );
      },
      site,
    );
    await wait(async () => {
      const response = await request(`/v1/sessions/${id}/commands`, {
        commands: [{ command: "get", what: "title" }],
      });
      return JSON.stringify(response).includes("Browser workshop");
    }, "viewer navigation");
    await shot("01-controlled-browser");
  });
  await check("state explanation describes human control", async () => {
    const state = await request(`/v1/sessions/${id}/explanation`);
    assert(state.reasons.some((reason) => reason.code === "human_control"));
  });
  await check("control transfer fences old commands and updates the viewer", async () => {
    const previous = leases.get(id);
    const next = await request(`/v1/sessions/${id}/control/transfer`, {
      mode: "agent",
      ttlMs: 60000,
    });
    leases.set(id, next.token);
    const denied = await fetch(`${api}/v1/sessions/${id}/commands`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${operator}`,
        "Content-Type": "application/json",
        "X-Steel-Control": previous,
      },
      body: JSON.stringify({ commands: [{ command: "click", target: { css: "button" } }] }),
    });
    assert.equal(denied.status, 409);
    await page.waitForFunction(() =>
      document.querySelector(".control-strip")?.textContent.includes("Observer"),
    );
    await click("Take control");
    await wait(() => leases.get(id) !== next.token, "fresh human lease");
  });
  await check("human handoff inbox, answer, persistent read state", async () => {
    await request(`/v1/sessions/${id}/handoff`, {
      reason: `Resolve fixture ${tag}`,
      instructions: "Select Save state, then describe the result.",
      timeoutMs: 300000,
    });
    await request(`/v1/sessions/${id}/commands`, {
      commands: [{ command: "click", target: { css: "button" } }],
    });
    await nav("Work inbox");
    await page.waitForFunction(
      (tag) => document.body.textContent.includes(`Resolve fixture ${tag}`),
      {},
      tag,
    );
    await click("Answer");
    await field(
      'dialog[open] textarea[name="note"]',
      "Saved the fixture state without any credentials.",
    );
    await click("Continue", "button", "dialog[open]");
    await wait(
      async () => (await request(`/v1/sessions/${id}/handoff`)).status === "done",
      "resolved handoff",
    );
    await page.waitForFunction(
      (tag) => {
        const card = [...document.querySelectorAll(".work-card")].find(
          (card) =>
            card.textContent.includes(`Resolve fixture ${tag}`) &&
            card.querySelector(".badge")?.textContent === "done",
        );
        const button = [...(card?.querySelectorAll("button") || [])].find(
          (button) => button.textContent.trim() === "Mark read" && !button.disabled,
        );
        if (!button) return false;
        button.click();
        return true;
      },
      {},
      tag,
    );
    const card = await wait(
      async () =>
        (await request("/v1/inbox")).items.find(
          (item) => item.sessionId === id && item.kind === "handoff" && item.readAt,
        ),
      "persisted read state",
    );
    await page.reload({ waitUntil: "networkidle0" });
    assert((await request("/v1/inbox")).items.find((item) => item.id === card.id).readAt);
    await shot("02-work-inbox");
  });
  await check("learned recovery is saved from actual completed handoff and versioned", async () => {
    await page.goto(`${base}/?session=${id}`, { waitUntil: "networkidle0" });
    await click("Take control");
    await click("Save what resolved this handoff");
    await field('dialog[open] input[name="origin"]', site);
    await field(
      'dialog[open] textarea[name="note"]',
      "Click Save state to prepare the local fixture.",
    );
    await click("Save lesson", "button", "dialog[open]");
    const lesson = await wait(
      async () =>
        (await request("/v1/recovery-knowledge")).knowledge.find(
          (item) => item.source.sessionId === id,
        ),
      "saved recovery",
    );
    owned.knowledge.push(lesson.id);
    assert.equal(lesson.origin, site);
    assert.equal(lesson.steps.length, 0);
    await request(
      `/v1/recovery-knowledge/${lesson.id}`,
      {
        expectedVersion: 1,
        steps: [{ seq: 1, tool: "browser_click", args: { selector: "button" }, replayable: true }],
      },
      "PUT",
    );
    await nav("Recovery knowledge");
    await page.waitForFunction(() => document.body.textContent.includes("v2"));
    await shot("03-recovery-knowledge");
  });
  await check("procedure creation via Workshop and immutable version", async () => {
    await nav("Procedures & runs");
    await click("New procedure");
    await form(
      "New reusable procedure",
      {
        name: `Review fixture ${tag}`,
        description: "Review a local page action, then verify its title.",
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
        steps: [
          {
            id: "save",
            kind: "commands",
            input: { commands: [{ command: "click", target: { css: "button" } }] },
            review: {
              summary: `Save fixture ${tag}`,
              destination: site,
              fields: { action: "Save state" },
              attachments: [],
            },
          },
          {
            id: "title",
            kind: "assert",
            assertion: {
              id: "title",
              label: "Browser title matches",
              command: { command: "get", what: "title" },
              path: "results.0.value",
              operator: "equals",
              expected: "Browser workshop",
              evidence: "value",
            },
          },
        ],
        recovery: [],
      },
      "Save",
    );
    const procedure = await wait(
      async () =>
        (await request("/v1/procedures")).procedures.find(
          (item) => item.name === `Review fixture ${tag}`,
        ),
      "saved procedure",
    );
    owned.procedures.push(procedure.id);
    assert.equal(procedure.version, 1);
    await click("Run version");
    await form(`Run ${procedure.name} · v1`, { sessionId: id, inputs: {} }, "Start task");
  });
  await check(
    "exact proposal review rejects agent role and stale hash, operator completes run",
    async () => {
      const review = await wait(
        async () =>
          (await request("/v1/reviews")).reviews.find(
            (item) => item.status === "pending" && item.proposal.summary === `Save fixture ${tag}`,
          ),
        "prepared review",
        60000,
      );
      await request(
        `/v1/reviews/${review.id}/decision`,
        { decision: "approve", contentHash: review.contentHash },
        "POST",
        agent,
        403,
      );
      await request(
        `/v1/reviews/${review.id}/decision`,
        { decision: "approve", contentHash: "0".repeat(64) },
        "POST",
        operator,
        409,
      );
      await click("Reviews");
      await page.waitForFunction(
        (tag) => document.body.textContent.includes(`Save fixture ${tag}`),
        {},
        tag,
      );
      await shot("04-prepared-review");
      await click("Approve exact action");
      await wait(
        async () => (await request(`/v1/runs/${review.runId}`)).status === "completed",
        "completed reviewed task",
        60000,
      );
      const receipt = await request(`/v1/receipts/${review.runId}`);
      assert.equal(receipt.status, "verified", JSON.stringify(receipt));
      await click("Results");
      await page.waitForFunction(() => document.body.textContent.includes("verified"));
      await shot("05-verified-result");
    },
  );
  await check("recovery executes only the explicitly accepted version", async () => {
    await page.goto(`${base}/?session=${id}`, { waitUntil: "networkidle0" });
    await click("Take control");
    await nav("Recovery knowledge");
    const before = (await request("/v1/runs")).runs.length;
    await click("Review and apply");
    assert.equal((await request("/v1/runs")).runs.length, before);
    await page.click('dialog[open] input[name="accepted"]');
    await click("Apply reviewed steps", "button", "dialog[open]");
    const procedureId = `recovery_${owned.knowledge[0]}_2`;
    owned.procedures.push(procedureId);
    await wait(
      async () =>
        (await request("/v1/runs")).runs.some(
          (run) => run.metadata?.productProcedureId === procedureId && run.status === "completed",
        ),
      "explicit recovery execution",
      60000,
    );
  });
  await check("identity inspection and profile editor use measured data", async () => {
    await nav("Identity & compatibility");
    await page.waitForFunction(() => document.body.textContent.includes("Actual browser"));
    await shot("06-identity-inspector");
    await click("Identity profiles");
    await click("New identity profile");
    await form(
      "Create identity profile",
      {
        name: `ui-${tag}`,
        settings: { compatibilityMode: "native", timezone: "UTC", locale: "en-US" },
        bindings: {},
      },
      "Save",
    );
    const saved = await wait(
      async () =>
        (await request("/v1/identity-profiles")).profiles.find(
          (profile) => profile.name === `ui-${tag}`,
        ),
      "saved identity profile",
    );
    owned.profiles.push(`ui-${tag}`);
    assert.equal(saved.revision, 1);
  });
  await check("page capture and retained search show source evidence", async () => {
    await page.goto(`${base}/?session=${id}`, { waitUntil: "networkidle0" });
    await click("Take control");
    await nav("Evidence & workspace");
    await click("Page changes");
    await form(
      "Capture a page baseline",
      { sessionId: id, name: `Baseline ${tag}`, selector: "body" },
      "Capture page",
    );
    const snapshot = await wait(
      async () =>
        (await request("/v1/page-snapshots")).snapshots.find(
          (item) => item.name === `Baseline ${tag}`,
        ),
      "saved snapshot",
    );
    owned.snapshots.push(snapshot.id);
    await click("Search");
    await form("Search retained work", { q: "browser", sessionId: id }, "Search");
    await page.waitForFunction(
      () => document.querySelectorAll(".search-results .work-card").length > 0,
    );
    await shot("07-retained-search");
  });
  await check("bounded diagnosis and checkpoint branch controls", async () => {
    await nav("Browser operations");
    await click("Diagnostics");
    await form("Diagnose a browser", { sessionId: id }, "Run diagnosis");
    await page.waitForSelector(".check-results");
    await shot("08-diagnosis");
    await click("Checkpoints");
    await form(
      "Save a named checkpoint",
      { sessionId: id, name: `Checkpoint ${tag}`, retentionDays: "1" },
      "Save checkpoint",
    );
    const checkpoint = await wait(
      async () =>
        (await request("/v1/checkpoints")).checkpoints.find(
          (item) => item.name === `Checkpoint ${tag}`,
        ),
      "checkpoint",
      60000,
    );
    owned.checkpoints.push(checkpoint.id);
    await click("Branch into new browser");
    const branch = await wait(
      async () =>
        (await request("/v1/sessions")).sessions.find(
          (session) => session.name === `Checkpoint ${tag}` && session.status === "live",
        ),
      "checkpoint branch",
      60000,
    );
    owned.sessions.push(branch.id);
    assert.notEqual(branch.id, id);
    assert.equal(branch.status, "live");
    await take(branch.id);
    const ticket = await request(`/v1/sessions/${branch.id}/control/ticket`, { channel: "cdp" });
    const branchBrowser = await puppeteer.connect({
      browserWSEndpoint: `${api.replace(/^http/, "ws")}/v1/sessions/${
        branch.id
      }/cdp?controlTicket=${encodeURIComponent(ticket.ticket)}`,
      headers: { Authorization: `Bearer ${operator}` },
    });
    try {
      const tab = (await branchBrowser.pages()).find((tab) => tab.url().startsWith(site));
      assert(tab);
      assert.equal(await tab.evaluate(() => localStorage.getItem("test")), "saved");
    } finally {
      branchBrowser.disconnect();
    }
    await shot("09-checkpoints");
  });
  await check("worker capabilities and unavailable services remain explicit", async () => {
    await nav("Browser fleet");
    await page.waitForSelector("form");
    await shot("10-fleet");
    assert(!(await page.content()).includes("Something went wrong"));
  });
  await check("mobile navigation keeps work reachable", async () => {
    await page.setViewport({ width: 390, height: 844 });
    await page.reload({ waitUntil: "networkidle0" });
    const expand = await page.$('button[aria-label="Expand sidebar"]');
    if (expand) await expand.click();
    await shot("11-mobile-navigation");
  });
  assert.deepEqual(errors, [], "browser runtime errors");
} catch (error) {
  reports.push({ name: "failure", passed: false, error: error.stack });
  await shot("failure").catch(() => {});
  throw error;
} finally {
  const cleanup = [];
  for (const id of owned.sessions) {
    try {
      await take(id);
      await request(`/v1/sessions/${id}/release`, {});
    } catch (error) {
      cleanup.push(String(error));
    }
  }
  for (const id of owned.knowledge)
    try {
      const item = await request(`/v1/recovery-knowledge/${id}`);
      await request(
        `/v1/recovery-knowledge/${id}?expectedVersion=${item.version}`,
        undefined,
        "DELETE",
      );
    } catch (error) {
      cleanup.push(String(error));
    }
  for (const [kind, path] of [
    ["procedures", "procedures"],
    ["snapshots", "page-snapshots"],
    ["profiles", "identity-profiles"],
    ["checkpoints", "checkpoints"],
  ])
    for (const id of owned[kind])
      try {
        await request(`/v1/${path}/${id}`, undefined, "DELETE");
      } catch (error) {
        cleanup.push(String(error));
      }
  await writeFile(
    join(artifacts, "results.json"),
    JSON.stringify({ reports, errors, cleanup }, null, 2),
  );
  await browser.close();
  if (cleanup.length) console.error("Cleanup failures:", cleanup.join("\n"));
}
