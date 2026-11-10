import Fastify from "fastify";
import pino from "pino";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
vi.mock("./env.js", () => ({ env: { ENABLE_VERBOSE_LOGGING: true } }));
import { loggingConfig } from "./config.js";
import { logValue } from "./utils/log-redaction.js";
function logger(config: any) {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, done) {
      text += chunk.toString();
      done();
    },
  });
  const { transport, ...options } = config;
  return { instance: pino(options, stream), text: () => text };
}
describe("credential-safe logging", () => {
  it("strips one-use tickets from normal Fastify error request URLs", async () => {
    const output = logger(loggingConfig.production);
    const app = Fastify({ loggerInstance: output.instance });
    app.get("/fail", async () => {
      throw new Error("Controlled failure");
    });
    await app.inject({
      url: "/fail?controlTicket=one-use-secret&ws=host%3FcontrolTicket%3Dnested-secret",
      headers: {
        authorization: "Bearer bearer-secret",
        "x-steel-control": "lease-secret",
        "x-steel-proxy-secret": "proxy-proof-secret",
      },
    });
    await app.close();
    const logged = output.text();
    expect(logged).toContain('"url":"/fail"');
    for (const secret of [
      "one-use-secret",
      "nested-secret",
      "bearer-secret",
      "lease-secret",
      "proxy-proof-secret",
    ])
      expect(logged).not.toContain(secret);
  });
  it("redacts structured values before verbose stringify bypasses Pino paths", () => {
    const output = logger(loggingConfig.development);
    output.instance.info(
      {
        req: {
          url: "/v1/sessions/id/devtools?controlTicket=ticket-secret",
          headers: {
            authorization: "Bearer auth-secret",
            "x-steel-control": "control-secret",
            "x-steel-proxy-secret": "proof-secret",
          },
        },
        nested: { controlToken: "nested-secret" },
      },
      "Verbose event",
    );
    (output.instance.info as (...args: unknown[]) => void)(
      "Transport failure",
      new Error("Failed ws://user:credential-secret@localhost/socket?controlTicket=url-secret"),
    );
    const logged = output.text();
    expect(logged).toContain("Verbose event");
    for (const secret of [
      "ticket-secret",
      "auth-secret",
      "control-secret",
      "proof-secret",
      "nested-secret",
      "credential-secret",
      "url-secret",
    ])
      expect(logged).not.toContain(secret);
    expect(logged).toContain("[redacted]");
  });
  it("handles circular records and does not erase useful nonsecret diagnostics", () => {
    const data: any = {
      method: "POST",
      url: "https://user:password@owned.test/path?token=secret",
      statusCode: 409,
    };
    data.self = data;
    expect(logValue(data)).toEqual({
      method: "POST",
      url: "https://owned.test/path",
      statusCode: 409,
      self: "[circular]",
    });
  });
});
