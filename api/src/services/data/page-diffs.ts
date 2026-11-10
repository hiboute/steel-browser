import type { Page, JSHandle } from "puppeteer-core";
import { createHash } from "node:crypto";
import * as mupdf from "mupdf";
import { DataError, DataRecords, type DataActor, type DataRecord } from "./common.js";
import { captureSource, type SourceBlock } from "./grounding.js";
import { isSensitiveSession } from "./privacy.js";

export interface SnapshotOptions {
  name?: string;
  selector?: string;
  ignoreSelectors?: string[];
  ignorePatterns?: string[];
  visual?: boolean;
}
export interface PageSnapshot extends DataRecord {
  name?: string;
  url: string;
  observedAt: string;
  text: string;
  blocks: SourceBlock[];
  options: SnapshotOptions;
  image?: string;
  digest: string;
}
export class PageDiffService {
  private captures = new WeakMap<Page, Promise<void>>();
  constructor(private records: DataRecords) {}
  async capture(page: Page, sessionId: string, actor: DataActor, options: SnapshotOptions) {
    const previous = this.captures.get(page) ?? Promise.resolve();
    const pending = Promise.withResolvers<void>();
    this.captures.set(page, pending.promise);
    await previous;
    try {
      return await this.captureMasked(page, sessionId, actor, options);
    } finally {
      pending.resolve();
      if (this.captures.get(page) === pending.promise) this.captures.delete(page);
    }
  }
  private async captureMasked(
    page: Page,
    sessionId: string,
    actor: DataActor,
    options: SnapshotOptions,
  ) {
    const assertImageAllowed = () => {
      if (options.visual && isSensitiveSession(sessionId))
        throw new DataError(
          "sensitive_session",
          "Saved images are disabled after a vault fill",
          409,
        );
    };
    assertImageAllowed();
    let masked:
      | JSHandle<{
          entries: Map<HTMLElement | SVGElement, { value: string; priority: string }>;
          observer: MutationObserver;
          failed: boolean;
        }>
      | undefined;
    const selector = options.selector || "body";
    try {
      // Validate all selectors before changing page state.
      const ignored = [
        "input",
        "textarea",
        "[contenteditable]",
        "[data-steel-sensitive]",
        ...(options.ignoreSelectors || []),
      ];
      await page.evaluate(
        (selectors) => {
          selectors.forEach((item) => document.querySelectorAll(item));
        },
        [selector, ...ignored],
      );
      // DOM style properties work under restrictive style-src CSP without bypassing
      // that policy. Keep exact handles and previous priorities for restoration.
      if (options.visual) {
        masked = await page.evaluateHandle((selectors) => {
          const entries = new Map<HTMLElement | SVGElement, { value: string; priority: string }>();
          const state = {
            entries,
            observer: undefined as unknown as MutationObserver,
            failed: false,
          };
          const apply = () => {
            const elements = new Set<HTMLElement | SVGElement>();
            for (const selector of selectors) {
              for (const element of document.querySelectorAll(selector)) {
                if (element instanceof HTMLElement || element instanceof SVGElement)
                  elements.add(element);
                if (elements.size > 5000) throw new Error("Snapshot masking limit exceeded");
              }
            }
            if (
              entries.size + [...elements].filter((element) => !entries.has(element)).length >
              5000
            )
              throw new Error("Snapshot masking limit exceeded");
            for (const element of elements) {
              if (!entries.has(element))
                entries.set(element, {
                  value: element.style.getPropertyValue("visibility"),
                  priority: element.style.getPropertyPriority("visibility"),
                });
              if (
                element.style.getPropertyValue("visibility") !== "hidden" ||
                element.style.getPropertyPriority("visibility") !== "important"
              )
                element.style.setProperty("visibility", "hidden", "important");
            }
          };
          apply();
          // Preserve masking for controls and matching attributes added while
          // screenshot capture is awaiting the renderer. Bounds fail closed.
          state.observer = new MutationObserver(() => {
            try {
              apply();
            } catch {
              state.failed = true;
              state.observer.disconnect();
            }
          });
          state.observer.observe(document, { subtree: true, childList: true, attributes: true });
          return state;
        }, ignored);
      }
      const source = await captureSource(page, 100_000, { selector, ignoreSelectors: ignored });
      let text = source.text
        .normalize("NFKC")
        .replace(/[\t ]+/g, " ")
        .replace(/\n\s*\n/g, "\n")
        .trim();
      for (const literal of options.ignorePatterns || [])
        text = text.split(literal).join("[ignored]");
      const image = options.visual
        ? Buffer.from(await page.screenshot({ type: "png", fullPage: false })).toString("base64")
        : undefined;
      if (masked && (await masked.evaluate((state) => state.failed)))
        throw new DataError(
          "masking_failed",
          "Page changed beyond the snapshot masking limit",
          409,
        );
      assertImageAllowed();
      if (image && image.length > 8_000_000)
        throw new DataError("image_too_large", "Snapshot image exceeds limit");
      const record = await this.records.create(
        "snapshot",
        actor.id,
        {
          name: options.name,
          url: source.url,
          observedAt: source.observedAt,
          text,
          blocks: source.blocks.filter((block) => text.includes(block.text)),
          options,
          image,
          digest: createHash("sha256").update(text).digest("hex"),
        },
        sessionId,
      );
      return this.metadata(record);
    } finally {
      await masked
        ?.evaluate(({ entries, observer }) => {
          observer.disconnect();
          for (const [element, { value, priority }] of entries) {
            if (
              element.style.getPropertyValue("visibility") !== "hidden" ||
              element.style.getPropertyPriority("visibility") !== "important"
            )
              continue;
            if (value) element.style.setProperty("visibility", value, priority);
            else element.style.removeProperty("visibility");
          }
        })
        .catch(() => undefined);
      await masked?.dispose().catch(() => undefined);
    }
  }
  metadata(record: PageSnapshot) {
    const { image, ...metadata } = record;
    return { ...metadata, hasImage: !!image };
  }
  get(id: string, actor: DataActor) {
    return this.records.get<PageSnapshot>("snapshot", id, actor);
  }
  remove(id: string, actor: DataActor) {
    return this.records.remove("snapshot", id, actor);
  }
  async compare(beforeId: string, afterId: string, actor: DataActor) {
    const [before, after] = await Promise.all([
      this.get(beforeId, actor),
      this.get(afterId, actor),
    ]);
    if (
      before.url !== after.url ||
      JSON.stringify({ ...before.options, name: undefined }) !==
        JSON.stringify({ ...after.options, name: undefined })
    )
      throw new DataError(
        "incompatible_snapshots",
        "Compare the same URL and capture options (including ignore rules)",
      );
    const oldLines = new Set(before.text.split(/\n/).filter(Boolean));
    const newLines = new Set(after.text.split(/\n/).filter(Boolean));
    const oldBlocks = new Map(before.blocks.map((block) => [block.selector, block.text]));
    const newBlocks = new Map(after.blocks.map((block) => [block.selector, block.text]));
    const changes = [...new Set([...oldBlocks.keys(), ...newBlocks.keys()])]
      .filter((key) => oldBlocks.get(key) !== newBlocks.get(key))
      .slice(0, 500)
      .map((selector) => ({
        selector,
        before: oldBlocks.get(selector) ?? null,
        after: newBlocks.get(selector) ?? null,
      }));
    return {
      before: before.id,
      after: after.id,
      url: after.url,
      changed: before.digest !== after.digest,
      text: {
        added: [...newLines].filter((line) => !oldLines.has(line)).slice(0, 500),
        removed: [...oldLines].filter((line) => !newLines.has(line)).slice(0, 500),
      },
      structured: changes,
      visual:
        before.image && after.image
          ? comparePixels(Buffer.from(before.image, "base64"), Buffer.from(after.image, "base64"))
          : { status: "untested", reason: "Both snapshots need visual capture" },
    };
  }
}
export function comparePixels(before: Buffer, after: Buffer) {
  const a = new mupdf.Image(before),
    b = new mupdf.Image(after);
  let ap: mupdf.Pixmap | undefined, bp: mupdf.Pixmap | undefined;
  try {
    if (a.getWidth() !== b.getWidth() || a.getHeight() !== b.getHeight())
      return { status: "changed", reason: "Image dimensions differ", changedRatio: 1 };
    if (a.getWidth() * a.getHeight() > 8_000_000)
      throw new DataError("image_too_large", "Image comparison exceeds pixel limit");
    ap = a.toPixmap();
    bp = b.toPixmap();
    const left = ap.getPixels(),
      right = bp.getPixels();
    if (left.length !== right.length)
      return { status: "changed", reason: "Image color formats differ", changedRatio: 1 };
    const components = ap.getNumberOfComponents();
    let changed = 0;
    for (let offset = 0; offset < left.length; offset += components) {
      if (
        Array.from({ length: components }, (_, i) =>
          Math.abs(left[offset + i] - right[offset + i]),
        ).some((delta) => delta > 12)
      )
        changed++;
    }
    return {
      status: changed ? "changed" : "unchanged",
      changedPixels: changed,
      changedRatio: changed / (a.getWidth() * a.getHeight()),
    };
  } finally {
    ap?.destroy();
    bp?.destroy();
    a.destroy();
    b.destroy();
  }
}
