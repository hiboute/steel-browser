import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import fp from "fastify-plugin";
import { expect, it } from "vitest";
import fleetPlugin from "./fleet.plugin.js";
import { PlatformStore } from "../platform/store.js";
import { AuditLog } from "../platform/audit.js";

it("audits scoped pairing and revocation without persisting either credential", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "steel-fleet-audit-"));
  const store = new PlatformStore(directory, "owned-test-encryption-key");
  const audit = new AuditLog(store);
  const server = Fastify();
  await server.register(fp(async app => {
    app.decorate("store", store);
    app.decorate("audit", audit);
    app.decorate("sessionService", { setLaunchPolicy: () => {} } as any);
    app.decorate("access", { actor: (request: any) => ({ id: "verified-owner", role: request.headers.authorization === "Bearer owned-operator" ? "operator" : "agent", authenticated: true }) } as any);
    app.decorate("control", { isGenerationCurrent: () => true, registerResource: async () => {} } as any);
  }, { name: "steel-platform" }));
  await server.register(fleetPlugin);
  const headers = { authorization: "Bearer owned-operator" };
  try {
    const input = { label: "Private desktop label", location: "home", engines: ["chromium"] };
    expect((await server.inject({ method: "POST", url: "/v1/fleet/pairings", payload: input })).statusCode).toBe(403);
    const paired = await server.inject({ method: "POST", url: "/v1/fleet/pairings", headers, payload: input });
    expect(paired.statusCode).toBe(200);
    const pairing = paired.json();
    const payload = { pairingToken: pairing.token, capabilities: { protocol: 1, engines: ["chromium"], commands: ["launch", "close"], capacity: 1, device: { kind: "desktop", os: "owned-test-os", graphics: "unknown", headless: false }, strictEgress: false, browserVersions: {} } };
    const registration = await server.inject({ method: "POST", url: "/v1/fleet/worker/register", payload });
    expect(registration.statusCode).toBe(200);
    const worker = registration.json();
    expect((await server.inject({ method: "POST", url: "/v1/fleet/worker/register", payload })).statusCode).toBe(401);
    expect((await server.inject({ method: "POST", url: `/v1/fleet/workers/${worker.workerId}/revoke`, headers, payload: {} })).statusCode).toBe(200);
    expect((await server.inject({ method: "POST", url: `/v1/fleet/worker/${worker.workerId}/poll`, headers: { authorization: `Bearer ${worker.token}` }, payload: { liveSessionIds: [] } })).statusCode).toBe(401);
    const events = await audit.list();
    expect(events.map(event => event.event)).toEqual(expect.arrayContaining(["fleet.pairing.created", "fleet.worker.paired", "fleet.worker.revoke"]));
    expect(events.find(event => event.event === "fleet.pairing.created")).toMatchObject({ client: "verified-owner", subject: pairing.profileScope });
    expect(events.find(event => event.event === "fleet.worker.paired")).toMatchObject({ subject: worker.workerId, detail: { profileScope: pairing.profileScope } });
    const persisted = JSON.stringify(events);
    expect(persisted).not.toContain(pairing.token);
    expect(persisted).not.toContain(worker.token);
    expect(persisted).not.toContain(input.label);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});
