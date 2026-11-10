import { randomUUID } from "node:crypto";
import type { PlatformStore } from "../platform/store.js";
import type { Session, StartSessionOptions } from "../session.service.js";
import type { IdentityReport, LabReport } from "./identity.service.js";
import type { CompatibilityMode } from "./types.js";

export const MODES: CompatibilityMode[] = ["compatible", "native", "legacy"];

export interface ModeScore {
  mode: CompatibilityMode;
  status: "measured" | "skipped" | "failed";
  /** 100 is a browser whose claims all agree with what it is. */
  score?: number;
  errors: string[];
  warnings: string[];
  failedChecks: string[];
  /** Traits a site can read that give automation away, however consistent the rest is. */
  signals: string[];
  reason?: string;
}
export interface Scorecard {
  schemaVersion: 1;
  id: string;
  at: string;
  browserVersion?: string;
  trigger: "nightly" | "manual" | "boot";
  modes: ModeScore[];
  /** Best measured mode; absent when nothing could be measured. */
  recommended?: CompatibilityMode;
  previous?: CompatibilityMode;
  changed: boolean;
}
export interface ScorecardDeps {
  store: PlatformStore;
  /** Runs `fn` in a temporary browser, or returns undefined when the pool is busy. */
  measure: <T>(
    options: Partial<StartSessionOptions>,
    fn: (session: Session) => Promise<T>,
  ) => Promise<T | undefined>;
  inspect: (id: string) => Promise<IdentityReport>;
  lab: (id: string) => Promise<LabReport>;
  publish?: (type: string, data: unknown) => void;
  /** "auto" follows the scorecard; a mode name pins it; "legacy" is the old behaviour. */
  configured?: string;
  now?: () => number;
}

export function signalsOf(values: any): string[] {
  const signals: string[] = [];
  if (!values) return signals;
  if (values.webdriver === true) signals.push("navigator.webdriver is true");
  if (/swiftshader|llvmpipe|software/i.test(String(values.graphics?.renderer ?? "")))
    signals.push("software GPU");
  if (/HeadlessChrome/.test(String(values.userAgent ?? ""))) signals.push("headless user agent");
  const screen = values.screen;
  if (screen?.width && screen?.innerWidth && screen.width < screen.innerWidth)
    signals.push("screen smaller than the window");
  return signals;
}

export function score(report: IdentityReport, lab: LabReport, mode: CompatibilityMode): ModeScore {
  const errors = report.issues.filter((i) => i.severity === "error").map((i) => i.code);
  const warnings = report.issues.filter((i) => i.severity === "warning").map((i) => i.code);
  const failedChecks = lab.checks.filter((c) => c.status === "fail").map((c) => c.name);
  const signals = signalsOf(report.observed.values);
  const value =
    100 - 20 * errors.length - 5 * warnings.length - 10 * failedChecks.length - 5 * signals.length;
  return {
    mode,
    status: "measured",
    score: Math.max(0, value),
    errors,
    warnings,
    failedChecks,
    signals,
  };
}

export function recommend(modes: ModeScore[]): CompatibilityMode | undefined {
  // MODES is the tie-break order: prefer a consistent declared identity, then
  // the plain browser, and the legacy script only when it truly scores best.
  return MODES.map((mode) => modes.find((m) => m.mode === mode))
    .filter((m): m is ModeScore => m?.status === "measured")
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0]?.mode;
}

/** Measures every identity mode on the real browser and keeps the history. */
export class ScorecardService {
  private running?: Promise<Scorecard>;
  private cached?: Scorecard | null;
  constructor(private readonly d: ScorecardDeps) {}
  private now() {
    return this.d.now?.() ?? Date.now();
  }

  async history(limit = 30): Promise<Scorecard[]> {
    const cards = await Promise.all(
      (await this.d.store.list("identity/scorecards"))
        .filter((f) => f.endsWith(".json"))
        .map((f) => this.d.store.read<Scorecard>(`identity/scorecards/${f}`)),
    );
    return cards
      .filter((c): c is Scorecard => !!c)
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, limit);
  }
  async latest(): Promise<Scorecard | undefined> {
    if (this.cached === undefined) this.cached = (await this.history(1))[0] ?? null;
    return this.cached ?? undefined;
  }

  /** The mode a browser gets when it asks for none. */
  async defaultMode(): Promise<CompatibilityMode | undefined> {
    const configured = (this.d.configured ?? "legacy").toLowerCase();
    if (configured === "legacy") return undefined;
    if (configured === "native" || configured === "compatible") return configured;
    // auto: follow the evidence, and be consistent rather than legacy until there is some.
    return (await this.latest())?.recommended ?? "compatible";
  }

  run(trigger: Scorecard["trigger"] = "manual"): Promise<Scorecard> {
    this.running ??= this.measureAll(trigger).finally(() => (this.running = undefined));
    return this.running;
  }

  private async measureAll(trigger: Scorecard["trigger"]): Promise<Scorecard> {
    const previous = (await this.latest())?.recommended;
    const modes: ModeScore[] = [];
    let browserVersion: string | undefined;
    for (const mode of MODES) {
      const empty = { errors: [], warnings: [], failedChecks: [], signals: [] };
      try {
        const measured = await this.d.measure(
          { compatibilityMode: mode, labels: { purpose: "stealth-scorecard" } },
          async (session) => {
            const report = await this.d.inspect(session.id);
            const lab = await this.d.lab(session.id);
            browserVersion ??= report.browserVersion;
            return score(report, lab, mode);
          },
        );
        modes.push(
          measured ?? { mode, status: "skipped", reason: "No free browser slot", ...empty },
        );
      } catch (error) {
        modes.push({
          mode,
          status: "failed",
          reason: error instanceof Error ? error.message.slice(0, 200) : "Measurement failed",
          ...empty,
        });
      }
    }
    const recommended = recommend(modes);
    const card: Scorecard = {
      schemaVersion: 1,
      id: randomUUID(),
      at: new Date(this.now()).toISOString(),
      browserVersion,
      trigger,
      modes,
      recommended,
      previous,
      changed: !!recommended && !!previous && recommended !== previous,
    };
    // A run that measured nothing says nothing; keep the last real one current.
    if (!modes.some((m) => m.status === "measured")) return card;
    await this.d.store.write(`identity/scorecards/${card.id}.json`, card);
    this.cached = card;
    for (const old of (await this.history(1000)).slice(90))
      await this.d.store.remove(`identity/scorecards/${old.id}.json`);
    this.d.publish?.("identity.scorecard", {
      id: card.id,
      recommended,
      previous,
      changed: card.changed,
      scores: Object.fromEntries(modes.map((m) => [m.mode, m.score ?? null])),
    });
    return card;
  }

  /** True when a nightly run is due: none in the last 20 hours, and it is night (UTC) or overdue. */
  async due(): Promise<boolean> {
    const last = await this.latest();
    const age = last ? this.now() - Date.parse(last.at) : Infinity;
    if (age < 20 * 3_600_000) return false;
    const hour = new Date(this.now()).getUTCHours();
    return age > 36 * 3_600_000 || (hour >= 1 && hour < 5);
  }
}
