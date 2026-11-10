import { hideSecrets } from "../commands/secrets.js";

const sensitiveSessions = new Set<string>();
const secretValues = new Set<string>();
export function markSensitiveSession(id: string) {
  sensitiveSessions.add(id);
}
export function isSensitiveSession(id: string) {
  return sensitiveSessions.has(id);
}
export function registerSecretValue(value: string) {
  if (secretValues.size >= 1000 && !secretValues.has(value))
    throw new Error(
      "Secret redaction capacity reached; restart the service before filling additional references",
    );
  secretValues.add(value);
}
export function redactSecretText(value: string) {
  return hideSecrets(
    value,
    [...secretValues].flatMap((secret) => [
      secret,
      encodeURIComponent(secret),
      Buffer.from(secret).toString("base64"),
    ]),
    1,
  );
}
export function redactKnownSecrets<T>(value: T): T {
  if (typeof value === "string") return redactSecretText(value) as T;
  if (Array.isArray(value)) return value.map(redactKnownSecrets) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactKnownSecrets(item)]),
    ) as T;
  return value;
}
