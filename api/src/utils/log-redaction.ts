/** Logging must not turn one-use browser tickets or proxy proofs into retained credentials. */
const secretKey = /authorization|cookie|password|secret|token|passphrase|api.?key|x-steel-control/i;
export function logUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return value.split(/[?#]/, 1)[0];
  }
}
export function logText(value: string): string {
  return value
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, (url) => logUrl(url))
    .replace(
      /((?:controlTicket|controlToken|pairingToken|token|password|passphrase|x-steel-control|x-steel-proxy-secret)(?:=|%3d))[^&\s"'<>]+/gi,
      "$1[redacted]",
    );
}
export function logValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return logText(value);
  if (!value || typeof value !== "object") return value;
  if (depth > 12) return "[truncated]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => logValue(item, depth + 1, seen));
  const input =
    value instanceof Error
      ? { ...value, name: value.name, message: value.message, stack: value.stack }
      : value;
  return Object.fromEntries(
    Object.entries(input).map(([key, item]) => [
      key,
      secretKey.test(key)
        ? "[redacted]"
        : /url$/i.test(key) && typeof item === "string"
        ? logUrl(item)
        : logValue(item, depth + 1, seen),
    ]),
  );
}
export function requestLog(request: any) {
  return {
    method: request.method,
    url: logUrl(String(request.url ?? request.raw?.url ?? "")),
    host: logText(String(request.headers?.host ?? "")),
    remoteAddress: request.ip ?? request.socket?.remoteAddress,
    remotePort: request.socket?.remotePort,
  };
}
