import type { StateExplanation, StateReason, StateTelemetry } from "./types.js";

/** Deterministic precedence; every simultaneous reason remains visible. */
export function explainState(snapshot: StateTelemetry, now = Date.now()): StateExplanation {
  const { session, handoff, ownership } = snapshot;
  const reasons: StateReason[] = [];
  const add = (reason: StateReason) => reasons.push(reason);
  if (["failed", "released"].includes(session.status))
    add({
      code: session.status,
      title: session.status === "failed" ? "Browser failed" : "Browser released",
      detail: session.releaseReason || "This browser is no longer running.",
      next: "Start a new browser or recover a retained checkpoint.",
      severity: session.status === "failed" ? "error" : "info",
    });
  for (const review of snapshot.reviews ?? [])
    if (["pending", "waiting"].includes(review.status))
      add({
        code: "review",
        title: "Waiting for your review",
        detail: review.description || review.title,
        since: review.updatedAt,
        next: "Approve or reject the exact proposed action in the work inbox.",
        severity: "attention",
        sourceId: `review:${review.id}`,
      });
  if (handoff?.status === "waiting" && Date.parse(handoff.expiresAt) > now)
    add({
      code: "handoff",
      title: "Waiting for human input",
      detail: handoff.reason,
      since: handoff.requestedAt,
      next: handoff.instructions || "Complete the requested step, then choose Done, continue.",
      severity: "attention",
      sourceId: `handoff:${handoff.id}`,
    });
  if (ownership?.mode === "human" && Date.parse(ownership.expiresAt) > now)
    add({
      code: "human_control",
      title: "A person has control",
      detail: `Control belongs to ${ownership.ownerId}. Agent input is paused.`,
      next: "Transfer control back to the agent and explicitly resume paused work.",
      severity: "info",
    });
  for (const run of snapshot.runs ?? [])
    if (["uncertain", "failed", "paused"].includes(run.status))
      add({
        code:
          run.status === "uncertain"
            ? "uncertain"
            : run.status === "failed"
            ? "run_failed"
            : "run_paused",
        title:
          run.status === "uncertain"
            ? "Outcome needs reconciliation"
            : run.status === "failed"
            ? "Task failed"
            : "Task paused",
        detail: run.description || run.title,
        since: run.updatedAt,
        next:
          run.status === "uncertain"
            ? "Check whether the external action occurred before deciding how to continue."
            : "Review the task's last result and explicitly resume when ready.",
        severity: run.status === "failed" ? "error" : "attention",
        sourceId: `run:${run.id}`,
      });
  if (snapshot.queue)
    add({
      code: "queue",
      title: `Waiting for browser capacity (${snapshot.queue.position} in queue)`,
      detail: "The browser request is waiting for an available slot.",
      next: "The scheduler will admit the request when its capacity and budget allow.",
      severity: "info",
    });
  for (const login of snapshot.auth ?? [])
    if (["expired", "failing"].includes(login.status))
      add({
        code: "authentication",
        title: "A saved login needs attention",
        detail: `${login.name}: ${login.status}`,
        next: "Check the saved login and sign in again if required.",
        severity: "attention",
      });
  if (session.status === "parked")
    add({
      code: "parked",
      title: "Browser is parked",
      detail: session.parkReason || "Its saved state is retained and no browser slot is occupied.",
      next: "Resume this browser when you want to continue.",
      severity: "info",
    });
  const running = snapshot.runs?.find((run) => ["running", "queued"].includes(run.status));
  if (running)
    add({
      code: running.status,
      title: running.status === "queued" ? "Task is queued" : "Task is running",
      detail: running.title,
      since: running.updatedAt,
      next: "The next durable step will run when its control and capacity requirements are met.",
      severity: "info",
      sourceId: `run:${running.id}`,
    });
  if (session.expiresAt && Date.parse(session.expiresAt) > now && session.status === "live")
    add({
      code: "inactivity",
      title: "Automatic expiry is scheduled",
      detail: `This browser will ${session.onExpire === "release" ? "release" : "park"} at ${
        session.expiresAt
      } unless activity changes the idle deadline.`,
      since: session.lastActivityAt,
      next: "Browser interaction refreshes its idle deadline; its absolute time limit still applies.",
      severity: "info",
    });
  if (!reasons.length)
    add({
      code: "ready",
      title: session.status === "live" ? "Browser is ready" : "Browser is idle",
      detail: "No pending work was reported by the available services.",
      since: session.lastActivityAt,
      next: "Open a page, start a task, or leave the browser for later.",
      severity: "info",
    });
  return {
    sessionId: session.id,
    observedAt: new Date(now).toISOString(),
    status: session.status,
    primary: reasons[0],
    reasons,
    lastAction: snapshot.lastAction
      ? {
          at: snapshot.lastAction.at,
          tool: snapshot.lastAction.tool,
          title: snapshot.lastAction.title,
          status: snapshot.lastAction.status,
        }
      : null,
    unavailable: [...new Set(snapshot.unavailable)],
  };
}
