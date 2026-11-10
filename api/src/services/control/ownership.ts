import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { PlatformStore } from "../platform/store.js";
import { AccessError, type Actor } from "./access.js";

export interface ControlLease {
  sessionId: string;
  ownerId: string;
  mode: "human" | "agent";
  generation: number;
  expiresAt: string;
}
export interface ConnectionCredential {
  sessionId: string;
  actor: Actor;
  generation: number;
  token: string;
  observer?: boolean;
}
interface Resource {
  ownerId: string;
  generation: number;
  lease?: ControlLease;
  digest?: string;
}
export class OwnershipService {
  private resources = new Map<string, Resource>();
  private pending = new Map<string, Promise<unknown>>();
  private tickets = new Map<
    string,
    { credential: ConnectionCredential; channel: string; expires: number }
  >();
  constructor(
    private store: PlatformStore,
    private changed: (id: string, lease: ControlLease | null) => Promise<void> | void = () => {},
  ) {}
  async initialize() {
    const saved = (await this.store.read<Record<string, Resource>>("control/resources.json")) ?? {};
    // Tokens never survive restart. Persisted generation prevents stale socket fencing reuse.
    for (const [id, r] of Object.entries(saved))
      this.resources.set(id, { ownerId: r.ownerId, generation: r.generation + 1 });
    await this.save();
  }
  owner(id: string) {
    return this.resources.get(id)?.ownerId;
  }
  readers(id: string) {
    const r = this.resources.get(id);
    return r ? [r.ownerId, ...(this.get(id) ? [this.get(id)!.ownerId] : [])] : [];
  }
  canRead(id: string, actor: Actor) {
    return actor.role === "operator" || this.readers(id).includes(actor.id);
  }
  isGenerationCurrent(id: string, generation: number) {
    return this.get(id)?.generation === generation;
  }
  private save() {
    return this.store.write(
      "control/resources.json",
      Object.fromEntries(
        [...this.resources].map(([id, r]) => [
          id,
          { ownerId: r.ownerId, generation: r.generation },
        ]),
      ),
    );
  }
  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const p = (this.pending.get(id) ?? Promise.resolve()).catch(() => {}).then(fn);
    this.pending.set(id, p);
    void p
      .finally(() => {
        if (this.pending.get(id) === p) this.pending.delete(id);
      })
      .catch(() => {});
    return p;
  }
  async registerResource(id: string, ownerId: string) {
    return this.serial(id, async () => {
      const old = this.resources.get(id);
      if (old && old.ownerId !== ownerId)
        throw new AccessError("owner_conflict", "Resource owner cannot be changed implicitly", 409);
      if (!old) {
        this.resources.set(id, { ownerId, generation: 0 });
        await this.save();
      }
    });
  }
  get(id: string): ControlLease | null {
    const r = this.resources.get(id);
    return r?.lease && Date.parse(r.lease.expiresAt) > Date.now() ? { ...r.lease } : null;
  }
  private resource(id: string, actor: Actor) {
    const r = this.resources.get(id);
    if (!r) throw new AccessError("session_not_found", "Browser ownership is unavailable", 404);
    if (!this.canRead(id, actor))
      throw new AccessError("session_denied", "Browser belongs to another principal");
    return r;
  }
  private async issue(
    id: string,
    r: Resource,
    actor: Actor,
    mode: "human" | "agent",
    ttlMs = 60000,
  ) {
    if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 300000)
      throw new AccessError(
        "invalid_lease",
        "Lease duration must be 1000–300000 milliseconds",
        400,
      );
    const token = randomBytes(32).toString("base64url");
    r.generation++;
    r.digest = createHash("sha256").update(token).digest("hex");
    r.lease = {
      sessionId: id,
      ownerId: actor.id,
      mode,
      generation: r.generation,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    };
    try {
      await this.save();
    } catch (error) {
      delete r.lease;
      delete r.digest;
      throw error;
    }
    await this.changed(id, { ...r.lease });
    return { lease: { ...r.lease }, token };
  }
  acquire(id: string, actor: Actor, options: { mode: "human" | "agent"; ttlMs?: number }) {
    return this.serial(id, async () => {
      const r = this.resource(id, actor);
      if (this.get(id))
        throw new AccessError(
          "control_held",
          "Control is already leased; request an explicit transfer",
          409,
        );
      return this.issue(id, r, actor, options.mode, options.ttlMs);
    });
  }
  assert(id: string, actor: Actor, token?: string) {
    const r = this.resource(id, actor);
    const lease = this.get(id);
    const digest = createHash("sha256")
      .update(token ?? "")
      .digest("hex");
    if (
      !lease ||
      lease.ownerId !== actor.id ||
      !r.digest ||
      !timingSafeEqual(Buffer.from(digest), Buffer.from(r.digest))
    )
      throw new AccessError("control_required", "A current control lease is required", 409);
  }
  renew(id: string, actor: Actor, token: string, ttlMs = 60000) {
    return this.serial(id, async () => {
      this.assert(id, actor, token);
      if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 300000)
        throw new AccessError("invalid_lease", "Invalid lease duration", 400);
      const r = this.resources.get(id)!;
      r.lease!.expiresAt = new Date(Date.now() + ttlMs).toISOString();
      return { lease: { ...r.lease! } };
    });
  }
  release(id: string, actor: Actor, token: string) {
    return this.serial(id, async () => {
      this.assert(id, actor, token);
      const r = this.resources.get(id)!;
      r.generation++;
      delete r.lease;
      delete r.digest;
      await this.save();
      await this.changed(id, null);
    });
  }
  transfer(
    id: string,
    actor: Actor,
    token: string | undefined,
    options: { mode: "human" | "agent"; ownerId?: string; ttlMs?: number },
  ) {
    return this.serial(id, async () => {
      const r = this.resource(id, actor);
      if (actor.role !== "operator") this.assert(id, actor, token);
      const next = { ...actor, id: options.ownerId ?? actor.id };
      if (next.id !== actor.id && actor.role !== "operator")
        throw new AccessError(
          "transfer_denied",
          "Only an operator can transfer to another principal",
        );
      return this.issue(id, r, next, options.mode, options.ttlMs);
    });
  }
  async invalidate(id: string) {
    return this.serial(id, async () => {
      const r = this.resources.get(id);
      if (!r) return;
      r.generation++;
      delete r.lease;
      delete r.digest;
      await this.save();
      await this.changed(id, null);
    });
  }
  issueTicket(id: string, actor: Actor, token: string, channel: "cdp" | "cast") {
    this.assert(id, actor, token);
    for (const [k, v] of this.tickets) if (v.expires <= Date.now()) this.tickets.delete(k);
    const ticket = randomBytes(24).toString("base64url");
    const expires = Date.now() + 30000;
    this.tickets.set(ticket, {
      credential: { sessionId: id, actor, generation: this.get(id)!.generation, token },
      channel,
      expires,
    });
    return { ticket, expiresAt: new Date(expires).toISOString() };
  }
  issueObserverTicket(id: string, actor: Actor) {
    this.resource(id, actor);
    const ticket = randomBytes(24).toString("base64url");
    const expires = Date.now() + 30000;
    this.tickets.set(ticket, {
      credential: { sessionId: id, actor, generation: 0, token: "", observer: true },
      channel: "cast",
      expires,
    });
    return { ticket, expiresAt: new Date(expires).toISOString() };
  }
  consumeTicket(ticket: string, id: string, channel: string): ConnectionCredential {
    const t = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!t || t.expires <= Date.now() || t.channel !== channel || t.credential.sessionId !== id)
      throw new AccessError("invalid_ticket", "Control ticket is invalid or expired");
    this.assertConnection(t.credential);
    return t.credential;
  }
  assertConnection(c: ConnectionCredential) {
    if (c.observer) {
      this.resource(c.sessionId, c.actor);
      return;
    }
    this.assert(c.sessionId, c.actor, c.token);
    if (this.get(c.sessionId)?.generation !== c.generation)
      throw new AccessError("stale_controller", "Control has transferred", 409);
  }
  async expire() {
    for (const id of this.resources.keys())
      await this.serial(id, async () => {
        const r = this.resources.get(id)!;
        if (!r.lease || Date.parse(r.lease.expiresAt) > Date.now()) return;
        r.generation++;
        delete r.lease;
        delete r.digest;
        await this.save();
        await this.changed(id, null);
      });
  }
  async assignResource(id: string, ownerId: string) {
    return this.serial(id, async () => {
      const previous = this.resources.get(id);
      this.resources.set(id, { ownerId, generation: (previous?.generation ?? 0) + 1 });
      await this.save();
      await this.changed(id, null);
    });
  }
  async close() {
    await Promise.allSettled([...this.pending.values()]);
    this.tickets.clear();
  }
}
