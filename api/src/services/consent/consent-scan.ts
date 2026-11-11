import type { ConsentContainer } from "./consent-rules.js";

export interface ScanRule {
  name: string;
  containers: string[];
  reject: string[];
  accept: string[];
  labels?: boolean;
}

export interface ScanConfig {
  rules: ScanRule[];
  /** Also look for banners recognised by their attributes and text (main frame only). */
  generic: boolean;
}

export interface ScanResult {
  containers: ConsentContainer[];
  /** elements[i][j] is the DOM element of containers[i].buttons[j]. */
  elements: Element[][];
  /** Whether an element is still rendered and can be clicked. */
  visible: (element: Element | undefined) => boolean;
}

/**
 * Runs inside the page (it is serialised, so it must not use anything from this
 * module's scope). It reads the DOM and reports the consent containers it sees
 * with their buttons; it never clicks and never changes the page.
 */
export function scanConsent(config: ScanConfig): ScanResult {
  const MAX_BUTTONS = 30;
  const view = document.defaultView!;

  const visible = (element: Element | undefined): boolean => {
    if (!element || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = view.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (style.pointerEvents === "none" || Number(style.opacity) === 0) return false;
    const check = (element as any).checkVisibility;
    if (typeof check === "function") {
      try {
        return !!check.call(element, {
          checkOpacity: true,
          checkVisibilityCSS: true,
          opacityProperty: true,
          visibilityProperty: true,
        });
      } catch {
        return true;
      }
    }
    return true;
  };

  const onScreen = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();
    return (
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < view.innerHeight &&
      rect.left < view.innerWidth
    );
  };

  // querySelectorAll that also looks into open shadow roots (Usercentrics lives in one).
  const deepAll = (root: Element, selector: string): Element[] => {
    const found: Element[] = [];
    const walk = (node: ParentNode, depth: number) => {
      try {
        found.push(...Array.from(node.querySelectorAll(selector)));
      } catch {
        return;
      }
      if (depth >= 3) return;
      const all = node.querySelectorAll("*");
      for (let i = 0; i < all.length && i < 4000; i++) {
        const shadow = all[i].shadowRoot;
        if (shadow) walk(shadow, depth + 1);
      }
    };
    walk(root, 0);
    if (root.shadowRoot) walk(root.shadowRoot, 1);
    return found;
  };

  const clean = (value: string | null | undefined): string =>
    (value ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  const textOf = (element: Element): string =>
    clean(
      (element as HTMLElement).innerText ||
        element.textContent ||
        (element as HTMLInputElement).value ||
        element.getAttribute("title"),
    );

  const BUTTONS = 'button, [role="button"], input[type="button"], input[type="submit"], a';
  // A link that goes somewhere is navigation, not a consent choice.
  const isButton = (element: Element): boolean => {
    if (element.tagName !== "A") return true;
    if (element.getAttribute("role") === "button") return true;
    const href = (element.getAttribute("href") ?? "").trim();
    return href === "" || href.startsWith("#") || href.toLowerCase().startsWith("javascript:");
  };

  const containers: ConsentContainer[] = [];
  const elements: Element[][] = [];
  const roots: Element[] = [];

  const report = (
    root: Element,
    manager: string,
    options: { generic?: boolean; labels?: boolean; reject?: string[]; accept?: string[] },
  ) => {
    const rejects = new Set<Element>();
    const accepts = new Set<Element>();
    for (const selector of options.reject ?? [])
      for (const el of deepAll(root, selector)) rejects.add(el);
    for (const selector of options.accept ?? [])
      for (const el of deepAll(root, selector)) accepts.add(el);
    const candidates = new Set<Element>([...rejects, ...accepts]);
    for (const el of deepAll(root, BUTTONS)) if (isButton(el)) candidates.add(el);
    const buttons: ConsentContainer["buttons"] = [];
    const nodes: Element[] = [];
    for (const el of candidates) {
      if (nodes.length >= MAX_BUTTONS) break;
      if (!visible(el) || (el as HTMLButtonElement).disabled) continue;
      const text = textOf(el);
      const label = clean(el.getAttribute("aria-label")) || text;
      if (!label) continue;
      buttons.push({
        label,
        ...(text && text !== label ? { text } : {}),
        ...(rejects.has(el) ? { reject: true } : {}),
        ...(accepts.has(el) ? { accept: true } : {}),
      });
      nodes.push(el);
    }
    if (!buttons.length) return;
    containers.push({
      manager,
      ...(options.generic ? { generic: true } : {}),
      ...(options.labels ? { labels: true } : {}),
      buttons,
    });
    elements.push(nodes);
    roots.push(root);
  };

  for (const rule of config.rules) {
    for (const selector of rule.containers) {
      let matches: Element[] = [];
      try {
        matches = Array.from(document.querySelectorAll(selector));
      } catch {
        continue;
      }
      for (const root of matches.slice(0, 3)) {
        if (roots.includes(root)) continue;
        // A shadow host is often an empty box around a fixed-position banner.
        if (!root.shadowRoot && root !== document.body && !(visible(root) && onScreen(root)))
          continue;
        report(root, rule.name, rule);
      }
    }
  }

  if (config.generic && document.body) {
    const HINT =
      '[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], ' +
      '[id*="gdpr" i], [class*="gdpr" i], [aria-label*="cookie" i], [aria-label*="consent" i]';
    const TAGS = new Set(["DIV", "SECTION", "ASIDE", "DIALOG", "FORM", "FOOTER"]);
    const COOKIE_WORDS = /cookie|kakor|evästeet|informasjonskapsler|ciasteczk/i;
    const FIELDS =
      'input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"])' +
      ':not([type="button"]):not([type="submit"]), textarea, select';
    let hinted: Element[] = [];
    try {
      hinted = Array.from(document.querySelectorAll(HINT)).slice(0, 200);
    } catch {
      hinted = [];
    }
    const known = roots.slice();
    const eligible = hinted.filter((el) => {
      if (!TAGS.has(el.tagName)) return false;
      if (known.some((root) => root === el || root.contains(el) || el.contains(root))) return false;
      if (!visible(el) || !onScreen(el)) return false;
      const text = ((el as HTMLElement).innerText || el.textContent || "").replace(/\s+/g, " ");
      if (text.length < 20 || text.length > 3000 || !COOKIE_WORDS.test(text)) return false;
      if (el.querySelector(FIELDS)) return false;
      const count = Array.from(el.querySelectorAll(BUTTONS)).filter(
        (button) => isButton(button) && visible(button),
      ).length;
      return count >= 1 && count <= 8;
    });
    // The outermost eligible element is the banner; its inner wrappers repeat it.
    const outer = eligible.filter(
      (el) => !eligible.some((other) => other !== el && other.contains(el)),
    );
    for (const root of outer.slice(0, 4)) report(root, "generic", { generic: true, labels: true });
  }

  return { containers, elements, visible };
}
