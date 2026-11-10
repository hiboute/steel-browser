import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { Browser, Page } from "puppeteer-core";
import { IdentityCollector } from "./collector.js";

describe("identity collector target readiness", () => {
  it("uses a fresh UUID accepted by the external collector contract", async () => {
    const nonces: string[] = [];
    const server = createServer((req, res) => {
      const url = new URL(req.url!, "http://localhost");
      const nonce = url.searchParams.get("nonce") ?? "";
      if (
        url.pathname !== "/observe" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nonce)
      ) {
        res.writeHead(400).end("Invalid nonce");
        return;
      }
      nonces.push(nonce);
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          nonce,
          ip: "203.0.113.1",
          headers: {
            "user-agent": "Chrome/149",
            "x-unrelated-private-header": "excluded",
          },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture address");
    const collector = new IdentityCollector(`http://127.0.0.1:${address.port}`);
    const pages: Array<{ close: ReturnType<typeof vi.fn> }> = [];
    const browser = {
      newPage: async () => {
        let body = "";
        const page = {
          goto: async (url: string) => {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Collector HTTP ${response.status}`);
            body = await response.text();
          },
          evaluate: async () => JSON.parse(body).headers,
          close: vi.fn(async () => {}),
        };
        pages.push(page);
        return page;
      },
    } as unknown as Browser;
    try {
      for (let i = 0; i < 2; i++) {
        expect(await collector.headers(browser)).toEqual({
          status: "measured",
          headers: { "user-agent": "Chrome/149" },
        });
      }
      expect(new Set(nonces).size).toBe(2);
      expect(pages.every((page) => page.close.mock.calls.length === 1)).toBe(true);
    } finally {
      await collector.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it.each([undefined, "http://collector.example"])(
    "waits for identity setup before collecting headers (%s)",
    async (origin) => {
      const collector = new IdentityCollector(origin);
      let ready = false;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const page = {
        goto: vi.fn(async () => {
          expect(ready).toBe(true);
        }),
        evaluate: vi.fn(async () => ({
          "user-agent": ready ? "Chrome/149" : "HeadlessChrome/149",
        })),
        close: vi.fn(async () => {}),
      };
      const browser = { newPage: async () => page } as unknown as Browser;
      const prepare = vi.fn(async (target: Page) => {
        expect(target).toBe(page);
        await gate;
        ready = true;
      });
      const result = collector.headers(browser, prepare);
      try {
        await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
        expect(page.goto).not.toHaveBeenCalled();
        expect(page.evaluate).not.toHaveBeenCalled();
        release();
        expect(await result).toMatchObject({
          status: "measured",
          headers: { "user-agent": "Chrome/149" },
        });
        expect(page.close).toHaveBeenCalledOnce();
      } finally {
        release();
        await collector.close();
      }
    },
  );

  it("closes a diagnostic page when target setup fails instead of measuring an unconfigured browser", async () => {
    const collector = new IdentityCollector();
    const page = { goto: vi.fn(), close: vi.fn(async () => {}) };
    const browser = { newPage: async () => page } as unknown as Browser;
    try {
      const result = await collector.headers(browser, async () => {
        throw Error("Target setup failed");
      });
      expect(result.status).toBe("unavailable");
      expect(page.goto).not.toHaveBeenCalled();
      expect(page.close).toHaveBeenCalledOnce();
    } finally {
      await collector.close();
    }
  });
});
