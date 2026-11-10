import { hideSecrets, htmlForms } from "../commands/secrets.js";

const sensitiveSessions = new Set<string>();
const secretVariants = new Set<string>();
let secretCharacters = 0;
export function markSensitiveSession(id: string) {
  sensitiveSessions.add(id);
}
export function isSensitiveSession(id: string) {
  return sensitiveSessions.has(id);
}
export function registerSecretValue(value: string) {
  const variants = [
    ...new Set([
      ...htmlForms([value]),
      encodeURIComponent(value),
      Buffer.from(value).toString("base64"),
    ]),
  ].filter((variant) => !secretVariants.has(variant));
  const added = variants.reduce((total, variant) => total + variant.length, 0);
  // The command engine's matcher has a 100,000-character budget. Never accept a
  // fill whose encoded variants would silently fall outside that redaction budget.
  if (secretCharacters + added > 90_000)
    throw new Error(
      "Secret redaction capacity reached; restart before filling additional references",
    );
  for (const variant of variants) secretVariants.add(variant);
  secretCharacters += added;
}
export function redactSecretText(value: string) {
  return hideSecrets(value, [...secretVariants], 1);
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
