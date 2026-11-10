import { expect, it } from "vitest";
import { visibleWorkSources } from "./adapters.js";
import type { WorkSource } from "./types.js";
const source = (kind: WorkSource["kind"], status: string): WorkSource => ({
  kind,
  id: kind === "run" ? "task" : kind,
  runId: "task",
  sessionId: "browser",
  ownerId: "alice",
  title: kind,
  status,
  updatedAt: "2026-11-10T12:00:00Z",
  revision: 1,
  actions: kind === "run" ? ["retry"] : [],
});
it("keeps paused, failed, and uncertain tasks actionable when they also have receipts", () => {
  for (const status of ["paused", "failed", "uncertain"]) {
    const cards = visibleWorkSources(
      [],
      [],
      [source("receipt", status === "paused" ? "waiting" : "failed")],
      [source("run", status)],
    );
    expect(cards.map((card) => card.kind)).toEqual(["run"]);
    expect(cards[0].actions).toContain("retry");
  }
});
it("represents a pending review once and a completed task with its receipt", () => {
  expect(
    visibleWorkSources(
      [],
      [source("review", "pending")],
      [source("receipt", "waiting")],
      [source("run", "paused")],
    ).map((card) => card.kind),
  ).toEqual(["review"]);
  expect(
    visibleWorkSources([], [], [source("receipt", "verified")], [source("run", "completed")]).map(
      (card) => card.kind,
    ),
  ).toEqual(["receipt"]);
});
