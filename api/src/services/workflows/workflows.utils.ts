import { createHash, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { WorkflowError, type ScheduleRecord } from "./workflows.types.js";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function equalDigest(a: string, b: string): boolean {
  return (
    /^[a-f0-9]{64}$/.test(a) &&
    /^[a-f0-9]{64}$/.test(b) &&
    timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"))
  );
}
export async function validateInputSchema(schema: Record<string, unknown>): Promise<void> {
  const worker = new Worker(
    `const {parentPort,workerData}=require('node:worker_threads');try{const Ajv=require(workerData.ajv);new Ajv({strict:false}).compile(workerData.schema);parentPort.postMessage({valid:true});}catch(error){parentPort.postMessage({valid:false,error:error.message});}`,
    {
      eval: true,
      execArgv: [],
      workerData: { ajv: createRequire(import.meta.url).resolve("ajv"), schema },
      resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 2 },
    },
  );
  let timer: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new WorkflowError(
              "invalid_input_schema",
              "Input schema compilation exceeded its limit",
            ),
          ),
        1000,
      );
      worker.once("message", (result) =>
        result.valid
          ? resolve()
          : reject(new WorkflowError("invalid_input_schema", String(result.error))),
      );
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code !== 0)
          reject(new WorkflowError("invalid_input_schema", "Input schema compilation failed"));
      });
    });
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
export function atPath(value: unknown, path: string): unknown {
  return path
    .split(".")
    .filter(Boolean)
    .reduce<unknown>((current, key) => {
      if (
        forbidden.has(key) ||
        !current ||
        typeof current !== "object" ||
        !Object.hasOwn(current, key)
      )
        return undefined;
      return (current as Record<string, unknown>)[key];
    }, value);
}
export function substitute(value: unknown, inputs: Record<string, unknown>, depth = 0): unknown {
  if (depth > 30)
    throw new WorkflowError("template_too_deep", "Procedure template is too deeply nested");
  if (Array.isArray(value)) return value.map((item) => substitute(item, inputs, depth + 1));
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length === 1 && typeof object.$input === "string") {
    const result = atPath(inputs, object.$input);
    if (result === undefined)
      throw new WorkflowError("missing_input", `Missing procedure input: ${object.$input}`);
    return structuredClone(result);
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, item] of Object.entries(object)) {
    if (forbidden.has(key)) throw new WorkflowError("unsafe_template", "Unsafe template property");
    result[key] = substitute(item, inputs, depth + 1);
  }
  return result;
}

/** Bound persisted payloads and reject obvious credentials rather than silently corrupting execution. */
export function validateSafePayload(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (serialized.length > 256000)
    throw new WorkflowError("payload_too_large", "Workflow payload exceeds 256 KB");
  const visit = (item: unknown, depth: number) => {
    if (depth > 30)
      throw new WorkflowError("payload_too_deep", "Workflow payload is too deeply nested");
    if (Array.isArray(item)) {
      item.forEach((v) => visit(v, depth + 1));
      return;
    }
    if (!item || typeof item !== "object") return;
    const object = item as Record<string, unknown>;
    if (
      ["fill", "type"].includes(String(object.command)) &&
      /password|passwd|credential|secret|token/i.test(JSON.stringify(object.target ?? ""))
    )
      throw new WorkflowError(
        "secret_value_forbidden",
        "Use a vault_fill step for credential fields",
      );
    for (const [key, child] of Object.entries(item)) {
      if (forbidden.has(key)) throw new WorkflowError("unsafe_payload", "Unsafe workflow property");
      if (
        /^(password|passwd|authorization|access_token|refresh_token|api_key|private_key|cookie|cookies)$/i.test(
          key,
        ) &&
        child !== undefined
      )
        throw new WorkflowError(
          "secret_value_forbidden",
          "Use approved vault references instead of storing credentials in workflows",
        );
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
}

export function localParts(date: Date, timezone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (key: string) => parts.find((p) => p.type === key)!.value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
  };
}

/** Daily wall-clock schedules skip nonexistent DST times and fire only once on repeated dates. */
export function nextScheduledAt(
  schedule: Pick<ScheduleRecord, "trigger" | "lastLocalDate">,
  after: Date,
): string | undefined {
  const trigger = schedule.trigger;
  if (trigger.kind === "interval")
    return new Date(after.getTime() + trigger.everySeconds * 1000).toISOString();
  if (trigger.kind !== "daily") return undefined;
  // Validate timezone eagerly even when the date is absent.
  localParts(after, trigger.timezone);
  const first = Math.floor(after.getTime() / 60000) * 60000 + 60000;
  for (let at = first; at < first + 3 * 86400000; at += 60000) {
    const parts = localParts(new Date(at), trigger.timezone);
    if (parts.time === trigger.at && parts.date !== schedule.lastLocalDate)
      return new Date(at).toISOString();
  }
  throw new WorkflowError("invalid_schedule", "Could not resolve the next local schedule time");
}
