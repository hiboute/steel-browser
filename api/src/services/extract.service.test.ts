import { describe, expect, it, vi } from "vitest";
import { ExtractService } from "./extract.service.js";
import { validateExtractedData } from "./extract-validation.js";

const schema = {
  type: "object",
  properties: { price: { type: "number" } },
  required: ["price"],
  additionalProperties: false,
};
const config = {
  baseUrl: "https://llm.example/v1",
  apiKey: "test-key",
  model: "spark",
  timeoutMs: 10000,
  maxChars: 20000,
};
const answer = (content: string) =>
  new Response(
    JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 12 } }),
    { status: 200 },
  );

describe("structured extraction", () => {
  it("bounds JSON schema pattern evaluation without blocking the API", async () => {
    let responsive = false;
    const timer = setTimeout(() => {
      responsive = true;
    }, 20);
    await expect(
      validateExtractedData({ type: "string", pattern: "^(a+)+$" }, "a".repeat(30000) + "!", 200),
    ).rejects.toThrow("execution limit");
    clearTimeout(timer);
    expect(responsive).toBe(true);
  });
  it("uses JSON schema output and returns validated data and usage", async () => {
    const request = vi.fn().mockResolvedValue(answer('{"price":12}'));
    const service = new ExtractService({} as never, config, request);
    const result = await service.fromText("The price is 12", schema);
    expect(result).toEqual({ data: { price: 12 }, model: "spark", usage: { total_tokens: 12 } });
    expect(request.mock.calls[0][0]).toBe("https://llm.example/v1/chat/completions");
    expect(JSON.parse(request.mock.calls[0][1].body).response_format.type).toBe("json_schema");
  });
  it("falls back when the provider rejects structured output, then repairs invalid JSON once", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response("unsupported", { status: 400 }))
      .mockResolvedValueOnce(answer('{"price":"12"}'))
      .mockResolvedValueOnce(answer('```json\n{"price":12}\n```'));
    const service = new ExtractService({} as never, config, request);
    expect((await service.fromText("price 12", schema)).data).toEqual({ price: 12 });
    expect(request).toHaveBeenCalledTimes(3);
    expect(JSON.parse(request.mock.calls[1][1].body)).not.toHaveProperty("response_format");
    expect(JSON.parse(request.mock.calls[2][1].body).messages.at(-1).content).toContain(
      "must be number",
    );
  });
  it("does not return unvalidated output after the repair fails", async () => {
    const request = vi.fn().mockImplementation(async () => answer('{"price":"bad"}'));
    const service = new ExtractService({} as never, config, request);
    await expect(service.fromText("price unknown", schema)).rejects.toMatchObject({
      code: "llm_failed",
      statusCode: 502,
    });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("rejects invalid schemas and mutually ambiguous sources before launching a browser", async () => {
    const sessions = { startSession: vi.fn() };
    const service = new ExtractService(sessions as never, config, vi.fn());
    await expect(
      service.extract({ url: "https://example.com", sessionId: "s", schema }),
    ).rejects.toMatchObject({ code: "invalid_source" });
    await expect(
      service.fromText("test", { $ref: "https://remote.example/schema.json" }),
    ).rejects.toMatchObject({ code: "invalid_schema" });
    expect(sessions.startSession).not.toHaveBeenCalled();
  });
  it("rejects private sources before allocating a browser", async () => {
    vi.stubEnv("EXTRAS_ALLOW_PRIVATE_NETWORKS", "false");
    const sessions = { startSession: vi.fn() };
    const service = new ExtractService(sessions as never, config, vi.fn());
    try {
      await expect(service.extract({ url: "http://127.0.0.1/", schema })).rejects.toMatchObject({
        code: "blocked_target",
        statusCode: 400,
      });
      expect(sessions.startSession).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("rechecks the atomic snapshot URL when an existing page navigates during extraction", async () => {
    vi.stubEnv("EXTRAS_ALLOW_PRIVATE_NETWORKS", "false");
    const release = vi.fn();
    const page = {
      url: () => "https://8.8.8.8/",
      evaluate: vi.fn().mockResolvedValue({
        url: "http://127.0.0.1/private",
        title: "Private page",
        html: "<html><body><p>Private data must not reach the model.</p></body></html>",
      }),
      createCDPSession: vi.fn(),
    };
    const sessions = {
      getSession: () => ({
        id: "existing",
        status: "live",
        cdpService: { getPrimaryPage: async () => page },
      }),
      holdActivity: () => release,
    };
    const request = vi.fn();
    try {
      await expect(
        new ExtractService(sessions as never, config, request).extract({
          sessionId: "existing",
          schema,
        }),
      ).rejects.toMatchObject({ code: "blocked_target" });
      expect(request).not.toHaveBeenCalled();
      expect(page.createCDPSession).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("does not expose the model's error body or API key", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(new Response("secret-provider-error", { status: 503 }));
    const service = new ExtractService({} as never, config, request);
    await expect(service.fromText("test", schema)).rejects.toThrow("HTTP 503");
  });
});
