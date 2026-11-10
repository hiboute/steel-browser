import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PlatformStore } from "../platform/store.js";
import { OwnershipService } from "./ownership.js";
import { AccessService, type Actor } from "./access.js";
import { BudgetService } from "./budgets.js";
let root: string, store: PlatformStore, control: OwnershipService;
const agent: Actor = { id: "agent@example.test", role: "agent", authenticated: true };
const human: Actor = { id: "operator@example.test", role: "operator", authenticated: true };
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "steel-control-"));
  store = new PlatformStore(root);
  control = new OwnershipService(store);
  await control.initialize();
  await control.registerResource("s", agent.id);
});
afterEach(async () => {
  await control.close();
  await rm(root, { recursive: true, force: true });
  vi.useRealTimers();
});
describe("verified identity", () => {
  it("separates human operator proof from the same principal's agent proof", async () => {
    const a = new AccessService(
      (id) => control.readers(id),
      (id, actor, token) => control.assert(id, actor, token),
      {},
      "agent-proof-at-least-24-characters",
      [agent.id],
      "human-proof-at-least-24-characters",
    );
    const from = (proof: string) =>
      a.authenticate({
        headers: { "x-steel-proxy-secret": proof, "x-steel-authenticated-user": agent.id },
      });
    const automated = from("agent-proof-at-least-24-characters"),
      humanOperator = from("human-proof-at-least-24-characters");
    expect(automated.id).toBe(humanOperator.id);
    expect(automated.role).toBe("agent");
    expect(humanOperator.role).toBe("operator");
    expect(() => a.operator(automated)).toThrow();
    expect(() => a.operator(humanOperator)).not.toThrow();
    await control.acquire("s", humanOperator, { mode: "human" });
    await expect(
      control.transfer("s", automated, undefined, { mode: "agent" }),
    ).rejects.toMatchObject({ code: "control_required" });
    await expect(
      control.transfer("s", humanOperator, undefined, { mode: "human" }),
    ).resolves.toMatchObject({ token: expect.any(String) });
  });

  it("rejects client attribution and unproved proxy identity", () => {
    const a = new AccessService(
      () => agent.id,
      () => {},
      { "a-strong-api-token-at-least-24-chars": agent },
      "another-secret-at-least-24-chars",
      [human.id],
    );
    expect(() =>
      a.authenticate({
        headers: { "x-steel-client": human.id, "x-steel-authenticated-user": human.id },
      }),
    ).toThrow();
    expect(
      a.authenticate({
        headers: {
          authorization: "Bearer a-strong-api-token-at-least-24-chars",
          "x-steel-client": human.id,
        },
      }),
    ).toEqual(agent);
    expect(
      a.authenticate({
        headers: {
          "x-steel-proxy-secret": "another-secret-at-least-24-chars",
          "x-steel-authenticated-user": human.id,
        },
      }),
    ).toEqual({ ...human, role: "agent" });
  });
  it("cannot read or mutate a different owner's session", async () => {
    const a = new AccessService(
      (id) => control.readers(id),
      (id, actor, token) => control.assert(id, actor, token),
      {},
    );
    const stranger = { ...agent, id: "other" };
    expect(() => a.assertRead(stranger, "s")).toThrow();
    const acquired = await control.acquire("s", agent, { mode: "agent" });
    expect(() => a.assertMutation(stranger, "s", acquired.token)).toThrow();
  });
});
describe("fenced leases", () => {
  it("serializes simultaneous acquisition and keeps renewal token stable", async () => {
    const results = await Promise.allSettled([
      control.acquire("s", agent, { mode: "agent" }),
      control.acquire("s", agent, { mode: "human" }),
    ]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const { token, lease } = (
      results.find((x) => x.status === "fulfilled") as PromiseFulfilledResult<any>
    ).value;
    await control.renew("s", agent, token, 1000);
    expect(control.get("s")?.generation).toBe(lease.generation);
    expect(() => control.assert("s", agent, token)).not.toThrow();
  });
  it("human takeover fences sockets while preserving original observer ACL", async () => {
    const previous = await control.acquire("s", agent, { mode: "agent" });
    const ticket = control.issueTicket("s", agent, previous.token, "cdp");
    const credential = control.consumeTicket(ticket.ticket, "s", "cdp");
    const next = await control.transfer("s", human, undefined, { mode: "human" });
    expect(() => control.assertConnection(credential)).toThrow();
    expect(control.isGenerationCurrent("s", previous.lease.generation)).toBe(false);
    expect(control.isGenerationCurrent("s", next.lease.generation)).toBe(true);
    expect(control.owner("s")).toBe(agent.id);
    expect(control.canRead("s", agent)).toBe(true);
  });
  it("operator delegation grants active controller access without losing original ownership", async () => {
    const next = { ...agent, id: "delegated" };
    const issued = await control.transfer("s", human, undefined, {
      mode: "agent",
      ownerId: next.id,
    });
    expect(() => control.assert("s", next, issued.token)).not.toThrow();
    await control.release("s", next, issued.token);
    expect(control.canRead("s", next)).toBe(false);
    expect(control.owner("s")).toBe(agent.id);
  });
  it("tickets are one-use, resource/channel bound and invalid after release", async () => {
    const issued = await control.acquire("s", agent, { mode: "agent" });
    const wrong = control.issueTicket("s", agent, issued.token, "cast");
    expect(() => control.consumeTicket(wrong.ticket, "s", "cdp")).toThrow();
    expect(() => control.consumeTicket(wrong.ticket, "s", "cast")).toThrow();
    const ticket = control.issueTicket("s", agent, issued.token, "cast");
    await control.release("s", agent, issued.token);
    expect(() => control.consumeTicket(ticket.ticket, "s", "cast")).toThrow();
  });
  it("expires even without another API request, and restart rejects old tokens", async () => {
    const changed = vi.fn();
    control = new OwnershipService(store, changed);
    await control.initialize();
    const previous = await control.acquire("s", agent, { mode: "agent", ttlMs: 1000 });
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(1001);
    await control.expire();
    expect(changed).toHaveBeenLastCalledWith("s", null);
    expect(() => control.assert("s", agent, previous.token)).toThrow();
    const next = await control.acquire("s", agent, { mode: "agent" });
    const restarted = new OwnershipService(store);
    await restarted.initialize();
    expect(() => restarted.assert("s", agent, next.token)).toThrow();
    expect(restarted.owner("s")).toBe(agent.id);
  });
  it("does not authorize a lease that failed durable persistence", async () => {
    vi.spyOn(store, "write").mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(control.acquire("s", agent, { mode: "agent" })).rejects.toThrow(
      "disk unavailable",
    );
    expect(control.get("s")).toBeNull();
  });
});
describe("admission budgets", () => {
  it("reloads the exact persisted policy after restart and accounts restored live sessions", async () => {
    const policy = {
      defaultMaxConcurrent: 3,
      clients: { [agent.id]: { maxConcurrent: 1, weight: 2 } },
      sites: { "https://owned.test": { maxConcurrent: 1 } },
    };
    const before = new BudgetService(store, true);
    await before.configure(policy);
    const after = new BudgetService(new PlatformStore(root), true);
    await after.initialize();
    expect(after.get().config).toEqual(policy);
    for (const sessionId of ["restored", "waiting"])
      after.register({
        sessionId,
        _principal: agent,
        siteScope: "https://owned.test",
        credentials: {},
      });
    after.acquired("restored");
    expect(after.reason("waiting")).toBe("client_budget");
    expect(after.metadata("waiting")).toEqual({ principal: agent.id, weight: 2 });
    after.release("restored");
    expect(after.canAcquire("waiting")).toBe(true);
    expect(after.get().active).toEqual([]);
    expect(after.get().sites["https://owned.test"]).toBe(0);
  });
  it("requires trusted principals and atomically accounts client/site capacity", async () => {
    const unsafe = new BudgetService(store, false);
    await expect(
      unsafe.configure({
        clients: { a: { maxConcurrent: 1, weight: 1 } },
        sites: {},
        defaultMaxConcurrent: 1000,
      }),
    ).rejects.toMatchObject({ code: "trusted_identity_required" });
    const b = new BudgetService(store, true);
    await b.configure({
      clients: { [agent.id]: { maxConcurrent: 1, weight: 2 } },
      sites: { "https://owned.test": { maxConcurrent: 1 } },
      defaultMaxConcurrent: 5,
    });
    for (const id of ["a", "b"])
      b.register({
        sessionId: id,
        _principal: agent,
        siteScope: "https://owned.test",
        credentials: {},
      });
    expect(b.canAcquire("a")).toBe(true);
    b.acquired("a");
    expect(b.reason("b")).toBe("client_budget");
    expect(b.claimSite("other", "https://owned.test/page")).toBe(false);
    await expect(
      b.configure({ clients: {}, sites: {}, defaultMaxConcurrent: 5 }),
    ).rejects.toMatchObject({ code: "browsers_active" });
    b.release("a");
    expect(b.canAcquire("b")).toBe(true);
  });
});

it("does not expire a new lease queued ahead of the expiry sweep", async () => {
  vi.useFakeTimers();
  await control.acquire("s", agent, { mode: "agent", ttlMs: 1000 });
  await vi.advanceTimersByTimeAsync(1001);
  const next = control.acquire("s", agent, { mode: "agent" });
  const expiry = control.expire();
  const issued = await next;
  await expiry;
  expect(() => control.assert("s", agent, issued.token)).not.toThrow();
});
it("observer tickets cannot become CDP control credentials", () => {
  const ticket = control.issueObserverTicket("s", agent);
  const credential = control.consumeTicket(ticket.ticket, "s", "cast");
  expect(credential.observer).toBe(true);
  expect(() => control.assert("s", agent, credential.token)).toThrow();
  expect(() =>
    control.consumeTicket(control.issueObserverTicket("s", agent).ticket, "s", "cdp"),
  ).toThrow();
});
