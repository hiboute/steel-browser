import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { expect, it } from "vitest";
import { PlatformStore } from "../platform/store.js";
import { DataRecords, type DataActor } from "./common.js";
import { captureSource, groundFields } from "./grounding.js";
import { PageDiffService } from "./page-diffs.js";
import { VaultService } from "./vault.js";
import { ExtractService } from "../extract.service.js";

const chrome =
  process.env.CHROME_EXECUTABLE_PATH ||
  (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
it.skipIf(!chrome)(
  "captures grounded source, ignores page noise and fills an approved field without exposing its secret",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "steel-data-browser-"));
    const browser = await puppeteer.launch({
      executablePath: chrome,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      userDataDir: path.join(root, "chrome"),
    });
    const actor: DataActor = { id: "browser-test", role: "agent", authenticated: true };
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 800, height: 600 });
      await page.setRequestInterception(true);
      page.on(
        "request",
        (request) =>
          void request.respond({
            status: 200,
            contentType: "text/html",
            headers: { "Content-Security-Policy": "default-src 'none'; form-action 'none'" },
            body: '<html><head><title>Tea catalog</title></head><body><main><h1>Tea</h1><p id="price">Price: 12</p><p id="clock">10:00</p><input id="password" type="text"><p id="echo"></p></main></body></html>',
          }),
      );
      await page.goto("https://8.8.8.8/catalog");
      const source = await captureSource(page);
      expect(groundFields({ name: "Tea", price: 12 }, source)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "/price", status: "grounded", selector: "#price" }),
        ]),
      );
      const service = new PageDiffService(
        new DataRecords(new PlatformStore(path.join(root, "data"), "key")),
      );
      const options = { ignoreSelectors: ["#clock"], visual: true };
      await page.$eval("#password", (element) => {
        (element as HTMLInputElement).value = "fixture-sensitive-Alpha";
      });
      await page.$eval("#clock", (element) =>
        (element as HTMLElement).style.setProperty("visibility", "visible", "important"),
      );
      const before = await service.capture(page, "session", actor, options);
      expect(
        await page.$eval("#clock", (element) => ({
          value: (element as HTMLElement).style.getPropertyValue("visibility"),
          priority: (element as HTMLElement).style.getPropertyPriority("visibility"),
        })),
      ).toEqual({ value: "visible", priority: "important" });
      await expect(
        service.capture(page, "session", actor, { ...options, selector: "#missing" }),
      ).rejects.toThrow("Snapshot selector not found");
      expect(
        await page.$eval("#password", (element) =>
          (element as HTMLElement).style.getPropertyValue("visibility"),
        ),
      ).toBe("");
      await page.$eval("#password", (element) => {
        (element as HTMLInputElement).value = "fixture-sensitive-Beta";
      });
      await page.$eval("#clock", (element) => {
        element.textContent = "11:00";
      });
      const noisy = await service.capture(page, "session", actor, options);
      expect(await service.compare(before.id, noisy.id, actor)).toMatchObject({
        changed: false,
        visual: { status: "unchanged" },
      });
      await page.$eval("#price", (element) => {
        element.textContent = "Price: 14";
      });
      const after = await service.capture(page, "session", actor, options);
      expect(await service.compare(before.id, after.id, actor)).toMatchObject({
        changed: true,
        structured: expect.arrayContaining([
          expect.objectContaining({ selector: "#price", after: "Price: 14" }),
        ]),
      });
      await page.$eval("#price", (element) => element.remove());
      const removed = await service.capture(page, "session", actor, options);
      expect(await service.compare(after.id, removed.id, actor)).toMatchObject({
        changed: true,
        text: { removed: expect.arrayContaining(["Price: 14"]) },
        structured: expect.arrayContaining([
          { selector: "#price", before: "Price: 14", after: null },
        ]),
      });
      const vault = new VaultService(
        JSON.stringify({
          password: {
            provider: "env",
            locator: "VAULT_TEST",
            origin: "https://8.8.8.8",
            selectors: ["#password"],
            clients: [actor.id],
          },
        }),
        async () => "secret-&-<unseen>-8392",
      );
      expect(
        await vault.fill(page, actor, { reference: "password", selector: "#password" }),
      ).toMatchObject({ status: "filled", submitted: false });
      expect(await page.$eval("#password", (element) => (element as HTMLInputElement).value)).toBe(
        "secret-&-<unseen>-8392",
      );
      await page.$eval("#echo", (element) => {
        element.textContent = (document.querySelector("#password") as HTMLInputElement).value;
      });
      expect(JSON.stringify(await captureSource(page))).not.toContain("secret-&-<unseen>-8392");
      const extraction = new ExtractService(
        {
          getSession: () => ({
            id: "session",
            status: "live",
            cdpService: { getPrimaryPage: async () => page },
          }),
          holdActivity: () => () => {},
        } as never,
        {
          baseUrl: "https://model.example/v1",
          model: "fixture",
          timeoutMs: 5000,
          maxChars: 10_000,
        },
        async (_url, init) => {
          expect(String(init?.body)).not.toContain("secret-&-<unseen>-8392");
          return new Response(
            JSON.stringify({
              choices: [
                { message: { content: JSON.stringify({ name: "Tea", nonexistent: "unicorn" }) } },
              ],
            }),
          );
        },
      );
      const extracted = await extraction.extract(
        {
          sessionId: "session",
          schema: {
            type: "object",
            properties: { name: { type: "string" }, nonexistent: { type: "string" } },
            required: ["name", "nonexistent"],
          },
        },
        actor.id,
      );
      expect(extracted.evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "/name", status: "grounded" }),
          expect.objectContaining({ path: "/nonexistent", status: "uncertain" }),
        ]),
      );
    } finally {
      await browser.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
