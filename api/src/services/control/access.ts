import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { FastifyRequest } from "fastify";

export interface Actor {
  id: string;
  role: "operator" | "agent";
  authenticated: boolean;
}
export class AccessError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 403,
  ) {
    super(message);
  }
}
const equal = (a: string, b: string) =>
  timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
export class AccessService {
  readonly configured: boolean;
  constructor(
    private owners: (id: string) => string | string[] | undefined,
    private mutation: (id: string, actor: Actor, token?: string) => void,
    private keys: Record<string, { id: string; role: "operator" | "agent" }> = JSON.parse(
      process.env.STEEL_AUTH_KEYS || "{}",
    ),
    private proxySecret = process.env.STEEL_TRUST_PROXY_SECRET,
    private operators = (process.env.STEEL_OPERATORS || "").split(",").filter(Boolean),
    private operatorProxySecret = process.env.STEEL_OPERATOR_PROXY_SECRET,
  ) {
    this.configured = Object.keys(keys).length > 0 || !!proxySecret || !!operatorProxySecret;
    for (const [key, actor] of Object.entries(keys))
      if (key.length < 24 || !actor.id || !["operator", "agent"].includes(actor.role))
        throw new Error("STEEL_AUTH_KEYS requires strong tokens and valid principals");
    if (proxySecret && proxySecret.length < 24)
      throw new Error("STEEL_TRUST_PROXY_SECRET must contain at least 24 characters");
    if (
      operatorProxySecret &&
      (operatorProxySecret.length < 24 || operatorProxySecret === proxySecret)
    )
      throw new Error(
        "STEEL_OPERATOR_PROXY_SECRET must be strong and distinct from the agent proxy proof",
      );
  }
  authenticate(request: Pick<IncomingMessage, "headers">): Actor {
    const authorization = request.headers.authorization;
    const token =
      typeof authorization === "string" && authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : "";
    if (token)
      for (const [key, actor] of Object.entries(this.keys))
        if (equal(token, key)) return { ...actor, authenticated: true };
    const proof = request.headers["x-steel-proxy-secret"];
    const user = request.headers["x-steel-authenticated-user"];
    if (
      typeof proof === "string" &&
      ((this.proxySecret && equal(proof, this.proxySecret)) ||
        (this.operatorProxySecret && equal(proof, this.operatorProxySecret))) &&
      typeof user === "string" &&
      /^[^\x00-\x20\x7f]{1,128}$/.test(user)
    )
      return {
        id: user,
        role:
          this.operatorProxySecret &&
          equal(proof, this.operatorProxySecret) &&
          this.operators.includes(user)
            ? "operator"
            : "agent",
        authenticated: true,
      };
    if (this.configured)
      throw new AccessError(
        "authentication_required",
        "A verified Steel credential is required",
        401,
      );
    return { id: "local", role: "operator", authenticated: false };
  }
  actor(request: Pick<FastifyRequest, "headers"> & { steelPrincipal?: Actor }): Actor {
    return request.steelPrincipal ?? this.authenticate(request);
  }
  assertRead(actor: Actor, id: string) {
    const owner = this.owners(id);
    if (
      actor.role !== "operator" &&
      !(Array.isArray(owner) ? owner.includes(actor.id) : owner === actor.id)
    )
      throw new AccessError("session_denied", "This browser is owned by another principal");
  }
  assertMutation(actor: Actor, id: string, token?: string) {
    this.assertRead(actor, id);
    this.mutation(id, actor, token);
  }
  authorizeSession(request: FastifyRequest, id: string, write = false): Actor {
    const actor = this.actor(request);
    const token = request.headers["x-steel-control"];
    if (write) this.assertMutation(actor, id, typeof token === "string" ? token : undefined);
    else this.assertRead(actor, id);
    return actor;
  }
  operator(actor: Actor) {
    if (actor.role !== "operator")
      throw new AccessError("operator_required", "An operator credential is required");
  }
}
