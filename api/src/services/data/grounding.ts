import type { Page } from "puppeteer-core";
import { hideSecrets } from "../commands/secrets.js";

import { redactSecretText } from "./privacy.js";

export interface SourceBlock {
  selector: string;
  text: string;
}
export interface GroundingSource {
  url: string;
  observedAt: string;
  text: string;
  blocks?: SourceBlock[];
}
export interface FieldEvidence {
  path: string;
  status: "grounded" | "uncertain" | "missing";
  url: string;
  observedAt: string;
  excerpt?: string;
  selector?: string;
  reason?: string;
}
const normalize = (text: string) => text.normalize("NFKC").replace(/\s+/g, " ").trim();
const escapePath = (value: string) => value.replace(/~/g, "~0").replace(/\//g, "~1");

/** Grounding is computed from captured source, never from model-provided citations. */
export function groundFields(
  data: unknown,
  source: GroundingSource,
  schema?: Record<string, unknown>,
): FieldEvidence[] {
  const result: FieldEvidence[] = [];
  const text = normalize(source.text);
  const visit = (value: unknown, path: string, depth: number) => {
    if (result.length >= 1000 || depth > 20) return;
    if (value && typeof value === "object" && Object.keys(value).length) {
      for (const [key, child] of Object.entries(value))
        visit(child, `${path}/${escapePath(key)}`, depth + 1);
      return;
    }
    const base = { path: path || "/", url: source.url, observedAt: source.observedAt };
    if (value === null || value === undefined || value === "") {
      result.push({ ...base, status: "missing", reason: "No value was extracted" });
      return;
    }
    // Boolean/inferred values cannot be verified merely by finding 'true' somewhere on a page.
    const needle =
      typeof value === "string" || typeof value === "number" ? normalize(String(value)) : "";
    let start = needle ? text.indexOf(needle) : -1;
    if (start >= 0 && typeof value === "number") {
      const left = text[start - 1] || "";
      const right = text[start + needle.length] || "";
      const leftJoined =
        /[\d+-]/.test(left) || (/[.,]/.test(left) && /\d/.test(text[start - 2] || ""));
      const rightJoined =
        /\d/.test(right) ||
        (/[.,]/.test(right) && /\d/.test(text[start + needle.length + 1] || ""));
      if (leftJoined || rightJoined) start = -1;
    }
    if (start < 0) {
      result.push({
        ...base,
        status: "uncertain",
        reason: "Value is not directly supported by the captured source",
      });
      return;
    }
    const block = source.blocks?.find((item) => normalize(item.text).includes(needle));
    result.push({
      ...base,
      status: "grounded",
      excerpt: text.slice(
        Math.max(0, start - 100),
        Math.min(text.length, start + needle.length + 100),
      ),
      ...(block ? { selector: block.selector } : {}),
      reason: "Value occurs verbatim in source; semantic field association still requires review",
    });
  };
  visit(data, "", 0);
  const missing = (
    value: unknown,
    definition: Record<string, unknown> | undefined,
    path: string,
    depth: number,
  ) => {
    if (
      !definition ||
      depth > 20 ||
      result.length >= 1000 ||
      !definition.properties ||
      typeof definition.properties !== "object"
    )
      return;
    for (const [key, property] of Object.entries(definition.properties)) {
      const child =
        value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
      const childPath = `${path}/${escapePath(key)}`;
      if (child === undefined)
        result.push({
          path: childPath,
          status: "missing",
          url: source.url,
          observedAt: source.observedAt,
          reason: "Schema field was not returned",
        });
      else if (property && typeof property === "object")
        missing(child, property as Record<string, unknown>, childPath, depth + 1);
    }
  };
  missing(data, schema, "", 0);
  return result;
}

/** Capture source and location atomically; form controls and known secret values never leave the page. */
export async function captureSource(
  page: Page,
  maxChars = 100_000,
  options: { selector?: string; ignoreSelectors?: string[] } = {},
) {
  const raw = await page.evaluate(
    ({ limit, options }) => {
      const secrets = Array.from(
        document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
          "input[type=password],[data-steel-sensitive]",
        ),
      )
        .map((element) => element.value || element.textContent || "")
        .filter(Boolean);
      const root = options.selector
        ? document.querySelector(options.selector)
        : document.documentElement;
      if (!root) throw new Error("Snapshot selector not found");
      const clone = root.cloneNode(true) as HTMLElement;
      for (const selector of options.ignoreSelectors || [])
        clone.querySelectorAll(selector).forEach((element) => element.remove());
      clone
        .querySelectorAll(
          "input,textarea,[contenteditable],script,style,noscript,[data-steel-sensitive]",
        )
        .forEach((element) => element.remove());
      clone
        .querySelectorAll("h1,h2,h3,h4,p,li,td,th,dt,dd,div,section,header,footer,br")
        .forEach((element) => element.append(document.createTextNode("\n")));
      const blocks: SourceBlock[] = [];
      for (const element of Array.from(
        document.querySelectorAll("h1,h2,h3,p,li,td,th,dt,dd,a"),
      ).slice(0, 2000)) {
        if (!root.contains(element) || element.closest("[data-steel-sensitive],[contenteditable]"))
          continue;
        if ((options.ignoreSelectors || []).some((selector) => element.closest(selector))) continue;
        const copy = element.cloneNode(true) as Element;
        copy
          .querySelectorAll("input,textarea,[contenteditable],[data-steel-sensitive]")
          .forEach((child) => child.remove());
        const text = (copy.textContent || "").replace(/\s+/g, " ").trim();
        if (!text) continue;
        const parts: string[] = [];
        let node: Element | null = element;
        while (node && node !== document.documentElement && parts.length < 12) {
          if (node.id) {
            parts.unshift(`#${CSS.escape(node.id)}`);
            break;
          }
          let index = 1;
          for (
            let sibling = node.previousElementSibling;
            sibling;
            sibling = sibling.previousElementSibling
          )
            if (sibling.tagName === node.tagName) index++;
          parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${index})`);
          node = node.parentElement;
        }
        blocks.push({ selector: parts.join(" > "), text: text.slice(0, 3000) });
      }
      return {
        url: location.href,
        title: document.title,
        observedAt: new Date().toISOString(),
        html: clone.outerHTML.slice(0, limit * 8),
        text: (clone.textContent || "").slice(0, limit),
        blocks,
        secrets,
      };
    },
    { limit: maxChars, options },
  );
  const mask = (value: string) => redactSecretText(hideSecrets(value || "", raw.secrets || [], 1));
  return {
    url: safeSourceUrl(raw.url),
    title: mask(raw.title),
    observedAt: raw.observedAt,
    html: mask(raw.html),
    text: mask(raw.text),
    blocks: (raw.blocks || []).map((block) => ({ ...block, text: mask(block.text) })),
  };
}

export function safeSourceUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.hash = "";
    url.search = "";
    return url.toString();
  } catch {
    return "about:blank";
  }
}
