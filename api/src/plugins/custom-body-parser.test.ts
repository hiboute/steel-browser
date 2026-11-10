import Fastify from "fastify";
import { describe, expect, test } from "vitest";
import customBodyParser from "./custom-body-parser.js";

describe("custom body parser", () => {
  test("does not discard invalid JSON on release routes", async () => {
    const app = Fastify();
    await app.register(customBodyParser);
    app.post("/v1/sessions/release", async (request) => request.body);
    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions/release",
      headers: { "content-type": "application/json" },
      payload: "{bad",
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
  test("answers invalid JSON with 400", async () => {
    const app = Fastify();
    await app.register(customBodyParser);
    app.post("/echo", async (request) => request.body);

    const invalid = await app.inject({
      method: "POST",
      url: "/echo",
      headers: { "content-type": "application/json" },
      payload: "{bad",
    });
    const valid = await app.inject({
      method: "POST",
      url: "/echo",
      headers: { "content-type": "application/json" },
      payload: '{"ok":true}',
    });

    expect(invalid.statusCode).toBe(400);
    expect(valid.json()).toEqual({ ok: true });
    await app.close();
  });
});
