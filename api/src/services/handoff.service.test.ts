import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlatformStore } from "./platform/store.js";
import { HandoffService } from "./handoff.service.js";
import type { Session } from "./session.service.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.useRealTimers();
});

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "steel-handoff-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = new PlatformStore(directory, "test-key");
  const page = {
    isClosed: () => false,
    url: () => "https://example.test/done",
    evaluate: vi.fn().mockResolvedValue(true),
  };
  const session = {
    id: "session-1",
    status: "live",
    isSelenium: false,
    cdpService: { getAllPages: async () => [page] },
  } as unknown as Session;
  const sessions = new Map([[session.id, session]]);
  const deps = {
    store,
    getSession: (id: string) => sessions.get(id),
    viewerUrl: "https://steel.test",
    publish: vi.fn(),
    notify: vi.fn().mockResolvedValue(undefined),
    changed: vi.fn().mockResolvedValue(undefined),
    log: vi.fn(),
  };
  const service = new HandoffService(deps);
  await service.initialize();
  cleanup.push(() => service.close());
  return { service, deps, session, sessions, page, store };
}

describe("human handoffs", () => {
  it("reserves one waiting handoff per live session even under concurrent creation", async () => {
    const { service, deps, session } = await setup();
    const result = await Promise.allSettled([
      service.create(session.id, { reason: "Sign in" }, "mcp:alice"),
      service.create(session.id, { reason: "Solve captcha" }, "mcp:bob"),
    ]);
    expect(result[0].status).toBe("fulfilled");
    expect(result[1]).toMatchObject({ status: "rejected", reason: { code: "handoff_waiting" } });
    expect(service.isWaiting(session.id)).toBe(true);
    expect(service.get(session.id)).toMatchObject({
      requestedBy: "mcp:alice",
      liveUrl: "https://steel.test/?session=session-1",
    });
    expect(deps.notify).toHaveBeenCalledOnce();
  });

  it("wakes long polls on completion and permits a new handoff afterward", async () => {
    const { service, session, deps } = await setup();
    await service.create(session.id, { reason: "Sign in", notify: false }, "client");
    const waiting = service.wait(session.id, 50);
    await service.resolve(session.id, "done", "ui", "Signed in");
    expect(await waiting).toMatchObject({ status: "done", resolvedBy: "ui", note: "Signed in" });
    expect(service.isWaiting(session.id)).toBe(false);
    expect(deps.notify).not.toHaveBeenCalled();
    await expect(
      service.create(session.id, { reason: "One more step" }, "client"),
    ).resolves.toMatchObject({ status: "waiting" });
  });

  it("expires handoffs and releases the idle exemption without a client polling", async () => {
    const { service, session } = await setup();
    vi.useFakeTimers({ toFake: ["Date"] });
    await service.create(session.id, { reason: "Sign in", timeoutMs: 1000 }, "client");
    vi.setSystemTime(Date.now() + 1001);
    await service.poll();
    expect(service.get(session.id)).toMatchObject({ status: "expired", resolvedBy: "timeout" });
    expect(service.isWaiting(session.id)).toBe(false);
  });

  it("polls all completion conditions and resolves only when they hold", async () => {
    const { service, session, page } = await setup();
    await service.create(
      session.id,
      {
        reason: "Log in",
        doneWhen: { urlMatches: "/done", selector: "#account", selectorGone: "#login" },
      },
      "client",
    );
    page.evaluate.mockImplementation(async (_fn, condition) => !condition);
    await service.poll();
    expect(service.isWaiting(session.id)).toBe(true);
    page.evaluate.mockResolvedValue(true);
    await service.poll();
    expect(service.get(session.id)).toMatchObject({ status: "done", resolvedBy: "condition" });
  });

  it("cancels on session disappearance and ends a disconnected long poll", async () => {
    const { service, session, sessions } = await setup();
    await service.create(session.id, { reason: "Sign in" }, "client");
    const abort = new AbortController();
    const waiting = service.wait(session.id, 50, abort.signal);
    abort.abort();
    expect((await waiting).status).toBe("waiting");
    sessions.delete(session.id);
    await service.poll();
    expect(service.get(session.id)).toMatchObject({ status: "cancelled", resolvedBy: "session" });
  });

  it("does not complete a replacement handoff when an older condition check finishes", async () => {
    const { service, session, page } = await setup();
    const first = await service.create(
      session.id,
      { reason: "First task", doneWhen: { selector: "#first" }, notify: false },
      "client",
    );
    const gate = Promise.withResolvers<boolean>();
    const evaluated = Promise.withResolvers<void>();
    page.evaluate.mockImplementation(async (_fn, condition) => {
      if (!condition) return true;
      evaluated.resolve();
      return gate.promise;
    });
    const polling = service.poll();
    await evaluated.promise;
    await service.resolve(session.id, "done", "ui");
    const second = await service.create(
      session.id,
      { reason: "Second task", doneWhen: { selector: "#second" }, notify: false },
      "client",
    );
    expect(second.id).not.toBe(first.id);
    gate.resolve(true);
    await polling;
    expect(service.get(session.id)).toMatchObject({
      id: second.id,
      status: "waiting",
      resolvedBy: null,
    });
  });

  it("ignores a queued timeout observation for a replaced handoff", async () => {
    const { service, session } = await setup();
    const first = await service.create(
      session.id,
      { reason: "First task", notify: false },
      "client",
    );
    const completed = service.resolve(session.id, "done", "ui");
    const replacement = service.create(
      session.id,
      { reason: "Replacement", notify: false },
      "client",
    );
    const staleTimeout = service.resolve(session.id, "expired", "timeout", undefined, first.id);
    await completed;
    const second = await replacement;
    await staleTimeout;
    expect(service.get(session.id)).toMatchObject({ id: second.id, status: "waiting" });
  });

  it("rejects invalid URL patterns and non-live sessions before reserving a handoff", async () => {
    const { service, session } = await setup();
    await expect(
      service.create(session.id, { reason: "Sign in", doneWhen: { urlMatches: "[" } }, "client"),
    ).rejects.toMatchObject({ code: "invalid_condition" });
    await expect(service.create("missing", { reason: "Sign in" }, "client")).rejects.toMatchObject({
      code: "not_live",
    });
    expect(service.list()).toEqual([]);
  });

  it("marks persisted waiting handoffs cancelled after a restart", async () => {
    const { service, session, deps } = await setup();
    await service.create(session.id, { reason: "Sign in" }, "client");
    const restarted = new HandoffService(deps);
    await restarted.initialize();
    cleanup.push(() => restarted.close());
    expect(restarted.get(session.id)).toMatchObject({
      status: "cancelled",
      resolvedBy: "shutdown",
    });
  });
});
