import { JSDOM } from "jsdom";
import { scanConfigFor } from "../consent.service.js";
import { scanConsent, type ScanConfig, type ScanResult } from "../consent-scan.js";

/**
 * jsdom has no layout: an element is given a box unless it, or an ancestor,
 * carries `hidden`, `data-off` or an inline `display: none`.
 */
export function createPage(html: string, url = "https://shop.example.com/") {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.Element.prototype.getBoundingClientRect = function (this: Element) {
    let node: Node | null = this;
    while (node) {
      const element = node.nodeType === 1 ? (node as HTMLElement) : undefined;
      if (
        element &&
        (element.hasAttribute("hidden") ||
          element.hasAttribute("data-off") ||
          element.style?.display === "none")
      )
        return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 } as DOMRect;
      node = node.parentNode ?? (node as ShadowRoot).host ?? null;
    }
    return {
      x: 10,
      y: 10,
      top: 10,
      left: 10,
      right: 210,
      bottom: 50,
      width: 200,
      height: 40,
    } as DOMRect;
  };
  const scan = window.eval(`(${scanConsent.toString()})`) as (config: ScanConfig) => ScanResult;
  return {
    window,
    document: window.document,
    scan: (config?: ScanConfig) => scan(config ?? scanConfigFor(url, true)!),
  };
}
