import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import type { Page } from "puppeteer-core";
import { z } from "zod";
import { DataError, type DataActor } from "./common.js";

import { registerSecretValue } from "./privacy.js";

const Reference = z
  .object({
    provider: z.enum(["env", "file", "op"]),
    locator: z.string().min(1).max(1000),
    origin: z.string().url(),
    selectors: z.array(z.string().min(1).max(500)).min(1).max(20),
    clients: z.array(z.string().min(1).max(128)).min(1).max(100),
    expiresAt: z.string().datetime().optional(),
    label: z.string().max(100).optional(),
  })
  .strict();
export type VaultReference = z.infer<typeof Reference>;
export interface VaultFillGuard {
  signal?: AbortSignal;
  assertControl(): void;
}
const execute = promisify(execFile);

export class VaultService {
  private references: Record<string, VaultReference>;
  constructor(
    config = process.env.STEEL_VAULT_REFERENCES || "{}",
    private resolve = resolveReference,
  ) {
    this.references = z
      .record(z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), Reference)
      .parse(JSON.parse(config));
    for (const reference of Object.values(this.references)) {
      const url = new URL(reference.origin);
      if (url.protocol !== "https:" || url.origin !== reference.origin)
        throw new Error("Vault origins must be exact HTTPS origins without path or credentials");
      if (reference.provider === "env" && !/^[A-Z][A-Z0-9_]{0,127}$/.test(reference.locator))
        throw new Error("Invalid configured vault environment reference");
      if (reference.provider === "file" && !reference.locator.startsWith("/"))
        throw new Error("Configured secret files must use absolute paths");
      if (reference.provider === "op" && !reference.locator.startsWith("op://"))
        throw new Error("Invalid configured 1Password reference");
    }
  }
  list(actor: DataActor) {
    return Object.entries(this.references)
      .filter(([, value]) => value.clients.includes(actor.id))
      .map(([id, value]) => ({
        id,
        label: value.label || id,
        origin: value.origin,
        selectors: value.selectors,
        expiresAt: value.expiresAt,
        provider: value.provider,
      }));
  }
  async fill(
    page: Page,
    actor: DataActor,
    input: { reference: string; selector: string; frameUrl?: string },
    guard?: VaultFillGuard,
  ) {
    const check = () => {
      if (guard?.signal?.aborted)
        throw new DataError("cancelled", "Secret fill was cancelled", 409);
      guard?.assertControl();
    };
    check();
    const reference = this.references[input.reference];
    if (!reference || !reference.clients.includes(actor.id))
      throw new DataError(
        "reference_denied",
        "Secret reference is not approved for this caller",
        403,
      );
    if (reference.expiresAt && Date.parse(reference.expiresAt) <= Date.now())
      throw new DataError("reference_expired", "Secret reference has expired", 409);
    if (!reference.selectors.includes(input.selector))
      throw new DataError(
        "target_denied",
        "Selector is not approved for this secret reference",
        403,
      );
    const frames = input.frameUrl
      ? page.frames().filter((frame) => frame.url() === input.frameUrl)
      : [page.mainFrame()];
    if (frames.length !== 1)
      throw new DataError("frame_ambiguous", "Select exactly one approved frame", 409);
    const frame = frames[0];
    const isOrigin = (url: string) => {
      try {
        return new URL(url).origin === reference.origin;
      } catch {
        return false;
      }
    };
    if (!isOrigin(page.url()) || !isOrigin(frame.url()))
      throw new DataError(
        "origin_denied",
        "Top-level page and target frame must match the approved HTTPS origin",
        403,
      );
    let secret: string;
    try {
      secret = await this.resolve(reference, guard?.signal);
    } catch {
      throw new DataError(
        "vault_unavailable",
        "Secret provider could not resolve the approved reference",
        503,
      );
    }
    if (!secret || secret.length > 16_384)
      throw new DataError(
        "invalid_secret",
        "Secret provider returned an empty or oversized value",
        502,
      );
    try {
      check();
      registerSecretValue(secret);
      // Origin and field checks execute in the same browser turn as the fill. Navigation between
      // provider retrieval and evaluation cannot send the value to a redirected origin.
      const result = await frame.evaluate(
        ({ origin, selector, value }) => {
          if (location.origin !== origin || window.top?.location.origin !== origin)
            return "origin_changed";
          const matches = document.querySelectorAll(selector);
          if (matches.length !== 1) return "target_ambiguous";
          const element = matches[0];
          if (
            !(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) ||
            element.disabled ||
            element.readOnly
          )
            return "target_unfillable";
          if (
            element instanceof HTMLInputElement &&
            !["text", "password", "email", "tel", "search", "url"].includes(element.type)
          )
            return "target_unfillable";
          element.setAttribute("data-steel-sensitive", "true");
          element.style.setProperty("-webkit-text-security", "disc", "important");
          const prototype =
            element instanceof HTMLInputElement
              ? HTMLInputElement.prototype
              : HTMLTextAreaElement.prototype;
          Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
          return "filled";
        },
        { origin: reference.origin, selector: input.selector, value: secret },
      );
      if (result !== "filled")
        throw new DataError(result, "The approved secret target changed or cannot be filled", 409);
      return {
        status: "filled",
        reference: input.reference,
        origin: reference.origin,
        selector: input.selector,
        submitted: false,
        at: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof DataError) throw error;
      // Browser errors can contain arguments or page-controlled text. Never return/log them here.
      throw new DataError(
        "fill_failed",
        "Secret fill failed; check the approved page and field",
        409,
      );
    } finally {
      secret = "";
    }
  }
}

async function resolveReference(reference: VaultReference, signal?: AbortSignal): Promise<string> {
  if (reference.provider === "env") return process.env[reference.locator] || "";
  if (reference.provider === "file") {
    const details = await stat(reference.locator);
    if (!details.isFile() || details.size > 16_384) throw new Error("Invalid secret file");
    return (await readFile(reference.locator, { encoding: "utf8", signal })).replace(/\r?\n$/, "");
  }
  const result = await execute("op", ["read", reference.locator, "--no-newline"], {
    timeout: 10_000,
    maxBuffer: 16_384,
    encoding: "utf8",
    signal,
  });
  return result.stdout;
}
