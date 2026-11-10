import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import puppeteer, { type Browser } from "puppeteer-core";
import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformStore } from "../platform/store.js";
import { PlatformEvents } from "../platform/events.js";
import { WorkflowService } from "./workflows.service.js";
import { RunService } from "../runs/runs.service.js";
import { OwnershipService } from "../control/ownership.js";
import { SessionCommands } from "../commands/registry.js";
import type { Actor } from "../control/access.js";
import type { Session, SessionService } from "../session.service.js";
import type { FileService } from "../file.service.js";
import nextPlatformPlugin from "../control/next-platform.plugin.js";
import workflowPlugin from "./workflows.plugin.js";

const chrome = process.env.CHROME_EXECUTABLE_PATH || "/usr/bin/chromium";
const actor: Actor = { id: "alice", role: "agent", authenticated: true };
const operator: Actor = { id: "operator", role: "operator", authenticated: true };
describe.skipIf(!existsSync(chrome))("procedures with the real durable runner and Chromium", () => {
  let root: string, fixture: Server, origin: string, committed: number, title: string;
  let store: PlatformStore,
    events: PlatformEvents,
    control: OwnershipService,
    commands: SessionCommands,
    runs: RunService,
    service: WorkflowService;
  let browsers: Browser[],
    records: Map<string, Session>,
    sessions: SessionService,
    initial: Session;
  let app: FastifyInstance | undefined;
  const launch = async () => {
    const browser = await puppeteer.launch({
      executablePath: chrome,
      headless: true,
      args: ["--no-sandbox", "--no-proxy-server"],
    });
    browsers.push(browser);
    const session = {
      id: randomUUID(),
      status: "live",
      isSelenium: false,
      cdpService: {
        getBrowserInstance: () => browser,
        waitForPageSetup: async () => {},
        getAllPages: () => browser.pages(),
      },
    } as unknown as Session;
    records.set(session.id, session);
    return session;
  };
  const initialize = async () => {
    control = new OwnershipService(store);
    await control.initialize();
    await control.registerResource(initial.id, actor.id);
    commands = new SessionCommands(sessions, {
      forSession: () => ({ getBaseFilesPath: () => root }),
    } as unknown as FileService);
    runs = new RunService(store, sessions, commands, control, (type, data, id) =>
      events.publish(type, data, id),
    );
    service = new WorkflowService({
      store,
      runtime: runs,
      events,
      replayOrigins: [origin],
      replayAllowPrivateNetworks: true,
      evidenceAllowed: () => true,
    });
    await runs.initialize();
    await service.initialize(false);
  };
  const until = async (predicate: () => boolean) => {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Timed out waiting for run state: " + JSON.stringify(runs.list(operator)));
  };
  const settle = async (id: string) =>
    until(() =>
      ["completed", "failed", "uncertain", "paused"].includes(runs.get(id, operator).status),
    );
  const reviewed = () => ({
    name: "Reviewed save",
    steps: [
      { id: "open", kind: "commands", input: { commands: [{ command: "navigate", url: origin }] } },
      {
        id: "fill",
        kind: "commands",
        input: { commands: [{ command: "fill", target: "#name", value: "Ada" }] },
      },
      {
        id: "submit",
        kind: "commands",
        input: { commands: [{ command: "click", target: "#submit" }] },
        review: {
          summary: "Save Ada",
          destination: origin + "/commit",
          fields: { name: "Ada" },
          attachments: [],
        },
      },
      {
        id: "wait",
        kind: "commands",
        input: { commands: [{ command: "wait", text: "Saved Ada" }] },
      },
      {
        id: "verify",
        kind: "assert",
        assertion: {
          id: "receipt",
          label: "Saved name",
          command: { command: "get", what: "text", target: "#receipt" },
          operator: "equals",
          expected: "Saved Ada",
          evidence: "screenshot",
        },
      },
    ],
  });
  beforeEach(async () => {
    app = undefined;
    root = await mkdtemp(path.join(tmpdir(), "steel-workflow-real-"));
    committed = 0;
    title = "Fixture";
    browsers = [];
    records = new Map();
    fixture = createServer((request, response) => {
      if (request.url === "/commit") {
        committed++;
        let input = "";
        request.on("data", (chunk) => (input += String(chunk)));
        request.on("end", () => response.end(`Saved ${input}`));
        return;
      }
      response.setHeader("Content-Type", "text/html");
      response.end(
        `<html><title>${title}</title><label>Name<input id="name"></label><button id="submit" onclick="fetch('/commit',{method:'POST',body:document.querySelector('#name').value}).then(r=>r.text()).then(t=>document.querySelector('#receipt').textContent=t)">Submit</button><p id="receipt"></p></html>`,
      );
    });
    await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
    initial = await launch();
    store = new PlatformStore(root, "integration-key");
    events = new PlatformEvents();
    sessions = {
      getSession: (id: string) => records.get(id),
      isParked: () => false,
      holdActivity: () => () => {},
      startSession: launch,
    } as unknown as SessionService;
    await initialize();
  });
  afterEach(async () => {
    await app?.close();
    await runs?.close();
    await service?.close();
    commands?.close();
    await control?.close();
    await Promise.all(browsers.map((browser) => browser.close()));
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  it("pauses before submission, approves immediately and verifies the actual result with PNG evidence", async () => {
    const procedure = await service.saveProcedure(reviewed(), actor);
    const run = await service.startProcedure(
      procedure.id,
      { sessionId: initial.id, idempotencyKey: "real" },
      actor,
    );
    await until(() => runs.get(run.id, actor).status === "paused");
    const review = (await service.listReviews(actor))[0];
    expect(review.preparedSnapshot).toContain("Ada");
    expect(committed).toBe(0);
    await service.decideReview(
      review.id,
      { decision: "approve", contentHash: review.contentHash },
      operator,
    );
    await settle(run.id);
    expect(runs.get(run.id, actor).status).toBe("completed");
    expect(committed).toBe(1);
    const receipt = await service.getReceipt(run.id, actor);
    expect(receipt.status).toBe("verified");
    expect(receipt.assertions[0].actual).toBe("Saved Ada");
    expect(receipt.assertions[0].evidence?.artifactId).toBeTruthy();
    const evidence = await service.getEvidence(receipt.assertions[0].evidence!.artifactId, actor);
    expect(evidence.data.subarray(1, 4).toString()).toBe("PNG");
  });
  it("refuses a stale approval after a human edits the prepared form", async () => {
    const procedure = await service.saveProcedure(reviewed(), actor);
    const run = await service.startProcedure(
      procedure.id,
      { sessionId: initial.id, idempotencyKey: "changed" },
      actor,
    );
    await until(() => runs.get(run.id, actor).status === "paused");
    const review = (await service.listReviews(actor))[0];
    const page = (await initial.cdpService.getAllPages())[0];
    await page.evaluate(() => {
      (document.querySelector("#name") as HTMLInputElement).value = "Eve";
    });
    await service.decideReview(
      review.id,
      { decision: "approve", contentHash: review.contentHash },
      operator,
    );
    await settle(run.id);
    expect(runs.get(run.id, actor).pauseReason).toBe("review_state_changed_create_new_run");
    expect(committed).toBe(0);
  });
  it("keeps a pending review and safe execution cursor over service restart", async () => {
    const procedure = await service.saveProcedure(reviewed(), actor);
    const run = await service.startProcedure(
      procedure.id,
      { sessionId: initial.id, idempotencyKey: "restart" },
      actor,
    );
    await until(() => runs.get(run.id, actor).status === "paused");
    const review = (await service.listReviews(actor))[0];
    await runs.close();
    await service.close();
    commands.close();
    await control.close();
    await initialize();
    expect((await service.getReview(review.id, actor)).status).toBe("pending");
    await service.decideReview(
      review.id,
      { decision: "approve", contentHash: review.contentHash },
      operator,
    );
    await settle(run.id);
    expect(runs.get(run.id, actor).status).toBe("completed");
    expect(committed).toBe(1);
    expect((await service.getReceipt(run.id, actor)).status).toBe("verified");
  });
  it("runs a baseline in fresh guarded browsers and detects an actual candidate regression", async () => {
    const procedure = await service.saveProcedure(
      {
        name: "Fixture title",
        steps: [
          {
            id: "open",
            kind: "commands",
            input: { commands: [{ command: "navigate", url: origin }] },
          },
          {
            id: "title",
            kind: "assert",
            assertion: {
              id: "title",
              label: "Fixture title",
              command: { command: "get", what: "title" },
              operator: "equals",
              expected: "Fixture",
            },
          },
        ],
      },
      actor,
    );
    const baseline = await service.startProcedure(
      procedure.id,
      { sessionId: initial.id, idempotencyKey: "baseline" },
      actor,
    );
    await settle(baseline.id);
    expect((await service.getReceipt(baseline.id, actor)).status).toBe("verified");
    const request = {
      baselineRunId: baseline.id,
      candidate: { label: "current candidate" },
      allowedOrigins: [origin],
      idempotencyKey: "candidate",
    };
    const first = await service.startReplay(request, actor);
    await settle(first.candidateRunId);
    const passed = await service.getReplay(first.id, actor);
    expect(passed.status).toBe("passed");
    expect(passed.observedBrowserVersion).toMatch(/Chrome/);
    expect(runs.get(first.candidateRunId, actor).sessionId).not.toBe(initial.id);
    title = "Changed title";
    const second = await service.startReplay(
      { ...request, idempotencyKey: "changed-candidate" },
      actor,
    );
    await settle(second.candidateRunId);
    const regressed = await service.getReplay(second.id, actor);
    expect(regressed.status).toBe("regressed");
    expect(regressed.differences[0]).toMatchObject({
      assertionId: "title",
      baseline: "Fixture",
      candidate: "Changed title",
    });
    expect(committed).toBe(0);
  });
  it("boots real plugins before starting recovered workflow steps", async () => {
    await (await initial.cdpService.getAllPages())[0].goto(origin);
    const procedure = await service.saveProcedure(
      {
        name: "Recovered read",
        steps: [
          {
            id: "title",
            kind: "assert",
            assertion: {
              id: "title",
              label: "Fixture title",
              command: { command: "get", what: "title" },
              operator: "equals",
              expected: "Fixture",
            },
          },
        ],
      },
      actor,
    );
    const run = await service.startProcedure(
      procedure.id,
      { sessionId: initial.id, idempotencyKey: "startup-order" },
      actor,
    );
    await settle(run.id);
    await runs.close();
    await service.close();
    commands.close();
    await control.close();
    const saved = await store.read<any>(`runs/${run.id}.json`);
    saved.status = "queued";
    saved.cursor = 0;
    saved.results = saved.results.map((r: any) => ({
      stepId: r.stepId,
      status: "pending",
      attempts: 0,
    }));
    delete saved.pauseReason;
    await store.write(`runs/${run.id}.json`, saved);
    Object.assign(initial, { ownerId: actor.id });
    Object.assign(sessions, {
      listSessions: () => [initial],
      activeSession: { id: "idle" },
      hooks: { add: () => () => {} },
    });
    app = Fastify();
    app.decorate("store", store);
    app.decorate("events", events);
    app.decorate("sessionService", sessions);
    app.decorate("fileService", {
      forSession: () => ({ getBaseFilesPath: () => root }),
    } as unknown as FileService);
    app.decorate("browserPool", { setSchedulingPolicy: () => {} } as any);
    const loadedWhenRunning: boolean[] = [];
    const unsubscribe = events.subscribe((event) => {
      const changed = (event.data as any)?.run;
      if (event.type === "run.updated" && changed?.id === run.id && changed.status === "running")
        loadedWhenRunning.push(
          app!.workflowService.listProcedures(operator).some((p) => p.id === procedure.id),
        );
    });
    await app.register(fp(async () => {}, { name: "steel-platform" }));
    await app.register(nextPlatformPlugin);
    await app.register(workflowPlugin, { actor: () => operator });
    app.addHook("onReady", async () => {
      await app!.runs.startRecovered();
    });
    await app.ready();
    runs = app.runs;
    service = app.workflowService;
    commands = app.sessionCommands;
    control = app.control;
    await until(() => runs.get(run.id, actor).status === "completed");
    expect(loadedWhenRunning.length).toBeGreaterThan(0);
    expect(loadedWhenRunning.every(Boolean)).toBe(true);
    await vi.waitFor(async () => {
      const receipt = await store.read<any>(`workflows/receipts/${run.id}.json`);
      expect(receipt?.status, JSON.stringify(receipt)).toBe("verified");
    });
    unsubscribe();
  });
});
