import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { Page } from "puppeteer-core";
import {
  WatcherDetails,
  type WatcherInput,
  type WatcherRecord,
  type WatcherRunDetails,
} from "../modules/extras/extras.schema.js";
import type { Session, StartSessionOptions } from "./session.service.js";
import type { PlatformStore } from "./platform/store.js";
import type { PlatformEvents } from "./platform/events.js";
import type { Notifier, NotificationInput } from "./platform/notifier.js";
import { ExtractService, ExtrasError, readablePage, waitForExtraction } from "./extract.service.js";
import { extrasConfig } from "./extras.config.js";
import { safeGoto } from "../utils/scrape/safeGoTo.js";
import { boundedRegex } from "./watchers-regex.js";
import {
  assertAllowedUrl,
  NavigationPolicyError,
  withNavigationPolicy,
} from "./navigation-policy.js";

interface BackgroundJobs {
  run<T>(
    kind: string,
    options: { sessionOptions?: StartSessionOptions; timeoutMs?: number },
    fn: (session: Session) => Promise<T>,
  ): Promise<T | undefined>;
}

export function withinActiveHours(hours: WatcherInput["activeHours"], now = new Date()): boolean {
  if (!hours || hours.start === hours.end) return true;
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      hourCycle: "h23",
      timeZone: hours.timezone,
    }).format(now),
  );
  return hours.start < hours.end
    ? hour >= hours.start && hour < hours.end
    : hour >= hours.start || hour < hours.end;
}

export async function matchesCondition(
  condition: WatcherInput["condition"],
  value: unknown,
  previous: unknown,
): Promise<boolean> {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  const expected = String(condition.value ?? "");
  switch (condition.type) {
    case "changed":
      return previous !== undefined && JSON.stringify(previous) !== JSON.stringify(value);
    case "contains":
      return text.includes(expected);
    case "not_contains":
      return !text.includes(expected);
    case "matches":
      return (await boundedRegex(expected, text.slice(0, 100000))) !== null;
    case "eq":
      return typeof condition.value === "number"
        ? Number(value) === condition.value
        : text === expected;
    case "lt":
      return Number.isFinite(Number(value)) && Number(value) < Number(condition.value);
    case "gt":
      return Number.isFinite(Number(value)) && Number(value) > Number(condition.value);
  }
}

export class WatcherService {
  private records = new Map<string, WatcherRecord>();
  private running = new Map<string, Promise<WatcherRunDetails>>();
  private mutations = new Map<string, Promise<unknown>>();
  private timer?: NodeJS.Timeout;
  private closed = false;
  private captureDiff?: (
    page: Page,
    record: WatcherRecord,
    sessionId: string,
  ) => Promise<{
    snapshotId: string;
    text: string;
    diff?: { changed: boolean; visual?: { status: string }; [key: string]: unknown };
  }>;
  setPageDiffs(capture: NonNullable<WatcherService["captureDiff"]>) {
    this.captureDiff = capture;
  }
  constructor(
    private store: PlatformStore,
    private jobs: BackgroundJobs,
    private extract: ExtractService,
    private events: Pick<PlatformEvents, "publish">,
    private notifier: Pick<Notifier, "send">,
    private logger: FastifyBaseLogger,
    private isClosing: () => boolean = () => false,
  ) {}

  private serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const task = (this.mutations.get(id) ?? Promise.resolve()).catch(() => undefined).then(action);
    this.mutations.set(id, task);
    void task
      .finally(() => {
        if (this.mutations.get(id) === task) this.mutations.delete(id);
      })
      .catch(() => undefined);
    return task;
  }

  async initialize() {
    for (const filename of await this.store.list("watchers")) {
      if (!filename.endsWith(".json")) continue;
      try {
        const record = WatcherDetails.parse(await this.store.read(`watchers/${filename}`));
        record.state.running = false;
        this.records.set(record.id, record);
      } catch (error) {
        this.logger.warn({ err: error, filename }, "Cannot load watcher");
      }
    }
    this.timer = setInterval(() => void this.tick(), extrasConfig.WATCHER_INTERVAL_MS);
    this.timer.unref();
  }

  list() {
    return [...this.records.values()].map((r) => ({ ...r, state: { ...r.state } }));
  }
  get(id: string) {
    const record = this.records.get(id);
    if (!record) throw new ExtrasError("watcher_not_found", "Watcher not found", 404);
    return record;
  }
  private validate(input: WatcherInput) {
    if (input.activeHours) withinActiveHours(input.activeHours);
    if (input.extract.regex) new RegExp(input.extract.regex);
    if (input.condition.type === "matches") new RegExp(String(input.condition.value ?? ""));
    if (input.extract.llm) this.extract.validateSchema(input.extract.llm.schema);
    if (input.extract.attribute && !input.extract.selector)
      throw new ExtrasError("invalid_watcher", "attribute requires a selector");
    if (input.condition.type !== "changed" && input.condition.value === undefined)
      throw new ExtrasError("invalid_watcher", "This condition requires a value");
  }
  async create(input: WatcherInput, client = "anonymous") {
    this.validate(input);
    const at = new Date().toISOString();
    const record: WatcherRecord = {
      ...input,
      id: randomUUID(),
      client,
      createdAt: at,
      updatedAt: at,
      state: { nextRunAt: at, consecutiveErrors: 0 },
    };
    await this.store.write(`watchers/${record.id}.json`, record);
    this.records.set(record.id, record);
    return record;
  }
  async update(id: string, input: WatcherInput) {
    this.validate(input);
    return this.serial(id, async () => {
      const previous = this.get(id);
      const record: WatcherRecord = {
        ...previous,
        ...input,
        updatedAt: new Date().toISOString(),
        state: { ...previous.state, nextRunAt: new Date().toISOString(), running: false },
      };
      if (
        previous.url !== record.url ||
        JSON.stringify(previous.pageDiff) !== JSON.stringify(record.pageDiff)
      ) {
        delete record.state.lastSnapshotId;
        delete record.state.lastValue;
      }
      await this.store.write(`watchers/${id}.json`, record);
      this.records.set(id, record);
      return record;
    });
  }
  async remove(id: string) {
    return this.serial(id, async () => {
      this.get(id);
      this.records.delete(id);
      await this.store.remove(`watchers/${id}.json`);
      await this.store.remove(`watchers/${id}.history.jsonl`);
    });
  }
  async history(id: string) {
    this.get(id);
    return this.store.readLines<WatcherRunDetails>(`watchers/${id}.history.jsonl`);
  }

  private async tick() {
    if (this.closed || this.isClosing()) return;
    for (const record of this.records.values()) {
      if (
        !record.enabled ||
        Date.parse(record.state.nextRunAt) > Date.now() ||
        !withinActiveHours(record.activeHours) ||
        this.running.has(record.id)
      )
        continue;
      void this.run(record.id).catch((error) =>
        this.logger.error({ err: error, watcherId: record.id }, "Watcher scheduling failed"),
      );
    }
  }

  run(id: string): Promise<WatcherRunDetails> {
    const existing = this.running.get(id);
    if (existing) return existing;
    const record = this.get(id);
    if (this.closed || this.isClosing())
      return Promise.reject(
        new ExtrasError("shutting_down", "Watcher service is shutting down", 503),
      );
    const promise = this.execute(record).finally(() => this.running.delete(id));
    this.running.set(id, promise);
    return promise;
  }

  private async execute(record: WatcherRecord): Promise<WatcherRunDetails> {
    const started = Date.now();
    const at = new Date(started).toISOString();
    record.state.running = true;
    let result: WatcherRunDetails;
    let notification: NotificationInput | undefined;
    try {
      await assertAllowedUrl(record.url);
      const job = await this.jobs.run(
        "watcher",
        {
          timeoutMs: 120000,
          sessionOptions: {
            credentials: {},
            cookieSets: record.cookieSets,
            egress: record.egress,
            client: record.client ?? "anonymous",
          } as StartSessionOptions,
        },
        async (session) => {
          const page = await session.cdpService.getPrimaryPage();
          return withNavigationPolicy(page, async (policy) => {
            await policy.assertUrl(record.url);
            await safeGoto(page, record.url, { timeout: 30000, waitUntil: "domcontentloaded" });
            await waitForExtraction(page, record.waitFor);
            policy.throwIfBlocked();
            if (record.pageDiff) {
              if (!this.captureDiff)
                throw new ExtrasError("diff_unavailable", "Page diff service is unavailable", 503);
              const captured = await this.captureDiff(page, record, session.id);
              return { value: captured.text, snapshotId: captured.snapshotId, diff: captured.diff };
            }
            return {
              value: await this.pageValue(page, record),
              snapshotId: undefined,
              diff: undefined,
            };
          });
        },
      );
      if (job === undefined) {
        record.state.nextRunAt = new Date(
          Date.now() + extrasConfig.WATCHER_INTERVAL_MS,
        ).toISOString();
        return { at, status: "postponed", durationMs: Date.now() - started };
      }
      const matched =
        record.pageDiff && record.condition.type === "changed"
          ? !!job.diff && (job.diff.changed || job.diff.visual?.status === "changed")
          : await matchesCondition(record.condition, job.value, record.state.lastValue);
      result = {
        at,
        status: "ok",
        value: job.value,
        matched,
        snapshotId: job.snapshotId,
        diff: job.diff,
        durationMs: Date.now() - started,
      };
      if (job.snapshotId) record.state.lastSnapshotId = job.snapshotId;
      record.state.lastValue = job.value;
      record.state.consecutiveErrors = 0;
      delete record.state.lastErrorNotifiedAt;
      if (matched && this.canNotify(record.state.lastNotifiedAt, record.notify.cooldownMinutes)) {
        notification = {
          event: "watcher.matched",
          severity: "info",
          title: `Page watch: ${record.name}`,
          message: `The ${record.condition.type} condition matched.`,
          url: record.url,
          data: {
            watcherId: record.id,
            value: job.value,
            snapshotId: job.snapshotId,
            diff: job.diff,
          },
        };
      }
    } catch (error) {
      record.state.consecutiveErrors++;
      result = {
        at,
        status: "error",
        error: error instanceof Error ? error.message : "Watcher failed",
        ...(error instanceof ExtrasError || error instanceof NavigationPolicyError
          ? { code: error.code, statusCode: error.statusCode }
          : {}),
        durationMs: Date.now() - started,
      };
      if (
        record.state.consecutiveErrors >= record.notify.onErrorAfter &&
        this.canNotify(record.state.lastErrorNotifiedAt, record.notify.cooldownMinutes)
      ) {
        notification = {
          event: "watcher.error",
          severity: "warning",
          title: `Page watch failed: ${record.name}`,
          message: `${record.state.consecutiveErrors} consecutive checks failed.`,
          url: record.url,
          data: { watcherId: record.id },
        };
      }
    } finally {
      record.state.running = false;
    }
    record.state.lastRunAt = at;
    record.state.nextRunAt = new Date(Date.now() + record.intervalMinutes * 60000).toISOString();
    // Serialize the identity check AND all subsequent writes with edits/deletion.
    // Checking identity before awaiting history alone would resurrect deleted files.
    await this.serial(record.id, async () => {
      if (this.records.get(record.id) !== record) return;
      if (notification) {
        await this.notifier
          .send(notification)
          .then(() => {
            if (notification!.event === "watcher.matched") record.state.lastNotifiedAt = at;
            else record.state.lastErrorNotifiedAt = at;
          })
          .catch((err) => this.logger.warn({ err }, "Watcher notification failed"));
      }
      const history = await this.store.readLines<WatcherRunDetails>(
        `watchers/${record.id}.history.jsonl`,
      );
      await this.store.rewriteLines(
        `watchers/${record.id}.history.jsonl`,
        [...history, result].slice(-50),
      );
      await this.store.write(`watchers/${record.id}.json`, record);
      this.events.publish("watcher.run", { watcherId: record.id, ...result });
    });
    return result;
  }

  private canNotify(at: string | undefined, minutes: number) {
    return !at || Date.now() - Date.parse(at) >= minutes * 60000;
  }
  private async pageValue(page: Page, record: WatcherRecord): Promise<unknown> {
    const options = record.extract;
    let text: string;
    if (options.selector) {
      await page.waitForSelector(options.selector, { timeout: 15000 });
      text = await page.$eval(
        options.selector,
        (element, attribute) =>
          attribute
            ? element.getAttribute(attribute) ?? ""
            : (element as HTMLElement).innerText ?? element.textContent ?? "",
        options.attribute,
      );
    } else if (options.fullText) {
      text = await page.evaluate(() => document.body?.innerText ?? "");
    } else {
      text = (await readablePage(page)).markdown;
    }
    text = text.slice(0, extrasConfig.EXTRACT_MAX_CHARS);
    if (options.regex) {
      const match = await boundedRegex(options.regex, text);
      text = match ? match[1] ?? match[0] : "";
    }
    if (options.llm)
      return (await this.extract.fromText(text, options.llm.schema, options.llm.prompt)).data;
    return text.trim();
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await Promise.allSettled([...this.running.values()]);
    await Promise.allSettled([...this.mutations.values()]);
  }
}
