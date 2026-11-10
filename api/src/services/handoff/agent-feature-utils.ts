import type { Page } from "puppeteer-core";
import type { Session } from "../session.service.js";

export class AgentFeatureError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function dataSessionId(id: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
    throw new AgentFeatureError(400, "invalid_session_id", "Invalid session ID");
  }
  return id;
}

export function configuredNumber(
  name: string,
  fallback: number,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

export async function bounded<T>(operation: Promise<T>, milliseconds = 5000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Browser operation timed out")), milliseconds);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Reading focus does not count as user activity or bring a background tab forward. */
export async function activePage(session: Session): Promise<Page | undefined> {
  const pages = (await bounded(session.cdpService.getAllPages())).filter(
    (page) => !page.isClosed(),
  );
  const focused = await Promise.all(
    pages.map(async (page) => {
      try {
        return await bounded(
          page.evaluate(() => document.hasFocus() && document.visibilityState === "visible"),
          2000,
        );
      } catch {
        return false;
      }
    }),
  );
  return pages[focused.indexOf(true)] ?? pages[0];
}

export async function screenshot(page: Page, width = 480): Promise<Buffer> {
  const client = await bounded(page.createCDPSession());
  try {
    const { cssVisualViewport: viewport } = await client.send("Page.getLayoutMetrics", undefined, {
      timeout: 3000,
    });
    const result = await client.send(
      "Page.captureScreenshot",
      {
        format: "jpeg",
        quality: 65,
        fromSurface: true,
        captureBeyondViewport: false,
        clip: {
          x: viewport.pageX,
          y: viewport.pageY,
          width: viewport.clientWidth,
          height: viewport.clientHeight,
          scale: Math.min(1, width / viewport.clientWidth),
        },
      },
      { timeout: 3000 },
    );
    return Buffer.from(result.data, "base64");
  } finally {
    await client.detach().catch(() => undefined);
  }
}

/** Persist only bounded, JSON-safe arguments and remove credential values. */
function hasPasswordTarget(value: unknown, depth = 0): boolean {
  if (depth > 8 || !value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (
    input.redacted === true ||
    input.isPassword === true ||
    [input.selector, input.type, input.inputType, input.input_type].some(
      (item) => typeof item === "string" && /password/i.test(item),
    ) ||
    [input.target, input.element, input.field, input.attributes, input.locator].some((item) =>
      hasPasswordTarget(item, depth + 1),
    )
  );
}

export function redactArguments(value: unknown, depth = 0, passwordContext = false): unknown {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") return value.slice(0, 10_000);
  if (Array.isArray(value))
    return value.slice(0, 100).map((item) => redactArguments(item, depth + 1, passwordContext));
  if (!value || typeof value !== "object") return value;
  const input = value as Record<string, unknown>;
  const passwordTarget = passwordContext || hasPasswordTarget(input);
  return Object.fromEntries(
    Object.entries(input)
      .slice(0, 100)
      .map(([key, item]) => [
        key,
        /password|secret|token|authorization|cookie|api.?key/i.test(key) ||
        (passwordTarget && /text|value|input/i.test(key))
          ? "[redacted]"
          : redactArguments(item, depth + 1, passwordTarget),
      ]),
  );
}
