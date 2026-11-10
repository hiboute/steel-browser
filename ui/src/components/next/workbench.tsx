import { useEffect, useRef, useState } from "react";
import {
  mutate,
  sessionPath,
  type SessionDetails,
  type Handoff,
  type TimelineEntry,
} from "../../api";
import { useResource } from "../../hooks";
import {
  heldControls,
  localControl,
  setLocalControl,
  useLocalControl,
  type ControlLease,
} from "../../control";
import { Page, ErrorMessage } from "../workspace-pages";
import {
  ActionForm,
  Empty,
  Field,
  JsonDetails,
  JsonField,
  json,
  string,
  useAction,
  when,
  ReviewProposal,
} from "./common";

interface Explanation {
  sessionId: string;
  observedAt: string;
  status: string;
  primary: Reason;
  reasons: Reason[];
  lastAction: { at: string; tool: string; title?: string } | null;
  unavailable: string[];
}
interface Reason {
  code: string;
  title: string;
  detail: string;
  next: string;
  since?: string;
  severity: string;
}
interface Card {
  id: string;
  sourceId: string;
  kind: string;
  sessionId?: string;
  runId?: string;
  status: string;
  title: string;
  description?: string;
  updatedAt: string;
  revision: string;
  readAt: string | null;
  dismissedAt: string | null;
  actions: string[];
  details?: {
    proposal?: {
      summary?: string;
      destination?: string;
      fields?: Record<string, unknown>;
      attachments?: Array<{ name: string; artifactId?: string; sha256?: string }>;
    };
    contentHash?: string;
    [key: string]: unknown;
  };
}
interface Knowledge {
  id: string;
  version: number;
  title: string;
  note: string;
  origin: string;
  procedureId?: string;
  ownerId: string;
  visibility: string;
  steps: Array<{ seq: number; tool: string; title?: string; args?: unknown; replayable: boolean }>;
  expiresAt: string;
  updatedAt: string;
  disabled: boolean;
  stale?: boolean;
  source: { sessionId: string; handoffId: string };
}

export function SessionWorkbench({ session }: { session: SessionDetails }) {
  const path = sessionPath(session.id),
    local = useLocalControl(session.id);
  const control = useResource<{ lease: ControlLease | null }>(`${path}/control`, 3000);
  const explanation = useResource<Explanation>(`${path}/explanation`, 5000);
  const action = useAction(control.refresh);
  useEffect(() => {
    const lease = control.data?.lease;
    if (
      local &&
      control.data &&
      (!lease ||
        lease.generation !== local.lease.generation ||
        lease.ownerId !== local.lease.ownerId)
    )
      setLocalControl(session.id, null);
  }, [control.data, session.id]);
  const take = async () => {
    const value = (await action.run(
      `${path}/control/${control.data?.lease ? "transfer" : "acquire"}`,
      {
        mode: "human",
        ttlMs: 60000,
      },
    )) as { lease: ControlLease; token: string };
    setLocalControl(session.id, value);
  };
  const release = async () => {
    await action.run(`${path}/control/release`, {});
    setLocalControl(session.id, null);
  };
  return (
    <section className="session-state">
      <div className="control-strip">
        <div>
          <span className={`badge ${local ? "good" : ""}`}>
            {local ? "You have control" : "Observer"}
          </span>
          <span>
            {control.data?.lease
              ? `${control.data.lease.mode === "human" ? "Human" : "Agent"} control · ${
                  control.data.lease.ownerId
                }`
              : "No active controller"}
          </span>
        </div>
        <div className="button-row">
          {["live", "parked"].includes(session.status) &&
            (local ? (
              <button
                className="pill-button"
                disabled={action.busy}
                onClick={() => void release().catch(() => {})}
              >
                Release control
              </button>
            ) : (
              <button
                className="pill-button"
                disabled={action.busy}
                onClick={() => void take().catch(() => {})}
              >
                Take control
              </button>
            ))}
          <a className="pill-button" href={`?view=identity&session=${session.id}`}>
            Inspect browser
          </a>
          <a className="pill-button" href={`?view=inbox&session=${session.id}`}>
            Work inbox
          </a>
        </div>
      </div>
      <ErrorMessage error={action.error || control.error} />
      {explanation.data ? (
        <details className="state-explanation">
          <summary>
            <b>{explanation.data.primary.title}</b>
            <span>{explanation.data.primary.next}</span>
          </summary>
          <div className="reason-grid">
            {explanation.data.reasons.map((reason, i) => (
              <article key={`${reason.code}-${i}`}>
                <strong>{reason.title}</strong>
                <p>{reason.detail}</p>
                <p className="field-hint">Next: {reason.next}</p>
                {reason.since && <small>{when(reason.since)}</small>}
              </article>
            ))}
          </div>
          {explanation.data.lastAction && (
            <p className="field-hint">
              Last action: {explanation.data.lastAction.title || explanation.data.lastAction.tool} ·{" "}
              {when(explanation.data.lastAction.at)}
            </p>
          )}
          {explanation.data.unavailable.length > 0 && (
            <p className="field-hint">
              Unavailable telemetry: {explanation.data.unavailable.join(", ")}
            </p>
          )}
        </details>
      ) : (
        <ErrorMessage error={explanation.error} />
      )}
      <SaveResolution session={session} />
    </section>
  );
}

/** Retain this tab's lease while its operator works in another Workshop view. */
export function ControlHeartbeat() {
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      for (const [id, current] of heldControls()) {
        if (!localControl(id)) {
          setLocalControl(id, null);
          continue;
        }
        void mutate<{ lease: ControlLease }>(`${sessionPath(id)}/control/renew`, { ttlMs: 60000 })
          .then((value) => {
            if (localControl(id)?.token === current.token)
              setLocalControl(id, { token: current.token, lease: value.lease });
          })
          .catch(() => {
            if (localControl(id)?.token === current.token) setLocalControl(id, null);
          });
      }
    }, 20000);
    return () => clearInterval(timer);
  }, []);
  return null;
}

export function InboxPage() {
  const [includeDismissed, setIncludeDismissed] = useState(false),
    [filter, setFilter] = useState("all");
  const resource = useResource<{ items: Card[]; unavailable: string[] }>(
    `/v1/inbox?includeDismissed=${includeDismissed}`,
    3000,
  );
  const action = useAction(resource.refresh),
    [answer, setAnswer] = useState<Card | null>(null),
    dialog = useRef<HTMLDialogElement>(null);
  const items = (resource.data?.items ?? []).filter((item) =>
    filter === "all" || filter === "attention"
      ? filter === "all" || item.actions.some((a) => a !== "open")
      : item.kind === filter,
  );
  const decide = (
    item: Card,
    kind: string,
    note?: string,
    resolution?: { stepId: string; outcome: string; evidence: string },
  ) =>
    action.run(
      `/v1/inbox/${encodeURIComponent(item.id)}/actions`,
      {
        expectedRevision: item.revision,
        action: kind,
        note,
        resolution,
        contentHash: item.details?.contentHash,
      },
      "POST",
      item.sessionId,
    );
  const mark = (item: Card, fields: object) =>
    action.run(
      `/v1/inbox/${encodeURIComponent(item.id)}`,
      { expectedRevision: item.revision, ...fields },
      "PATCH",
    );
  return (
    <Page
      title="Work inbox"
      description="Work that needs your input, proposed actions, and verified results across your browsers."
    >
      <div className="filter-bar">
        <select
          className="input"
          aria-label="Filter work"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">All work</option>
          <option value="attention">Needs attention</option>
          <option value="review">Reviews</option>
          <option value="receipt">Results</option>
          <option value="run">Tasks</option>
          <option value="handoff">Human input</option>
        </select>
        <label className="check-row">
          <input
            type="checkbox"
            checked={includeDismissed}
            onChange={(e) => setIncludeDismissed(e.target.checked)}
          />
          Show dismissed
        </label>
        <button className="pill-button" onClick={resource.refresh}>
          Refresh
        </button>
      </div>
      <ErrorMessage error={resource.error || action.error} />
      {resource.data?.unavailable.length ? (
        <p role="status" className="field-hint">
          Some work sources are unavailable: {resource.data.unavailable.join(", ")}.
        </p>
      ) : null}
      {resource.data && items.length === 0 && (
        <Empty>
          {includeDismissed
            ? "No work matches this filter."
            : "You're caught up. New work will appear here."}
        </Empty>
      )}
      <div className="inbox-list">
        {items.map((item) => (
          <article
            key={item.id}
            className="work-card"
            data-unread={!item.readAt}
            data-dismissed={!!item.dismissedAt}
          >
            <div className="card-heading">
              <div>
                <p className="eyebrow">
                  {item.kind} · {when(item.updatedAt)}
                </p>
                <h2>{item.title}</h2>
              </div>
              <span className="badge">{item.status}</span>
            </div>
            {item.description && <p>{item.description}</p>}
            {item.details?.proposal && (
              <div className="review-state">
                <strong>{item.details.proposal.summary}</strong>
                <ReviewProposal proposal={item.details.proposal} />
                {typeof item.details.expiresAt === "string" && (
                  <p className="field-hint">Review deadline: {when(item.details.expiresAt)}</p>
                )}
                <JsonDetails value={item.details.preparedSnapshot} label="Prepared page state" />
              </div>
            )}
            {item.kind === "receipt" && (
              <JsonDetails value={item.details} label="Outcome checks and evidence" />
            )}
            <div className="button-row">
              {item.actions.includes("open") && item.sessionId && (
                <a className="pill-button" href={`?session=${item.sessionId}`}>
                  Open browser
                </a>
              )}
              {item.actions.includes("answer") && (
                <button
                  className="pill-button"
                  disabled={action.busy}
                  onClick={() => {
                    setAnswer(item);
                    dialog.current?.showModal();
                  }}
                >
                  Answer
                </button>
              )}
              {item.actions.includes("retry") && (
                <button
                  className="pill-button"
                  disabled={action.busy}
                  onClick={() => {
                    setAnswer(item);
                    dialog.current?.showModal();
                  }}
                >
                  Review and resume
                </button>
              )}
              {item.actions.includes("approve") && (
                <button
                  className="pill-button"
                  disabled={action.busy}
                  onClick={() => void decide(item, "approve").catch(() => {})}
                >
                  Approve exact action
                </button>
              )}
              {item.actions.includes("reject") && (
                <button
                  className="pill-button"
                  disabled={action.busy}
                  onClick={() => void decide(item, "reject").catch(() => {})}
                >
                  Reject
                </button>
              )}
              <button
                className="pill-button"
                disabled={action.busy}
                onClick={() => void mark(item, { read: !item.readAt }).catch(() => {})}
              >
                {item.readAt ? "Mark unread" : "Mark read"}
              </button>
              <button
                className="pill-button"
                disabled={action.busy}
                onClick={() => void mark(item, { dismissed: !item.dismissedAt }).catch(() => {})}
              >
                {item.dismissedAt ? "Restore" : "Dismiss"}
              </button>
            </div>
          </article>
        ))}
      </div>
      <dialog className="dialog" ref={dialog}>
        <form
          key={answer?.revision}
          className="dialog-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!answer) return;
            const form = new FormData(e.currentTarget);
            void decide(
              answer,
              answer.kind === "handoff" ? "answer" : "retry",
              string(form, "note"),
              string(form, "resolution")
                ? {
                    stepId: string(form, "stepId"),
                    outcome: string(form, "resolution"),
                    evidence: string(form, "note"),
                  }
                : undefined,
            )
              .then(() => dialog.current?.close())
              .catch(() => {});
          }}
        >
          <div className="dialog-head">
            <h2>
              {answer?.kind === "handoff" ? "Complete this handoff" : "Reconcile and resume work"}
            </h2>
          </div>
          <div className="dialog-body">
            <p>{answer?.description || answer?.title}</p>
            <label className="field">
              Resolution notes
              <textarea
                className="input"
                name="note"
                rows={4}
                placeholder="What changed? Omit credentials and one-time codes."
              />
            </label>
            {answer?.kind === "run" && (
              <>
                <Field
                  name="stepId"
                  label="Interrupted step ID"
                  value={
                    typeof answer.details?.stepId === "string" ? answer.details.stepId : undefined
                  }
                  hint="Required when reconciling an uncertain side effect."
                />
                <label className="field">
                  Outcome of the last action
                  <select className="input" name="resolution">
                    <option value="">Use the run's normal retry policy</option>
                    <option value="applied">I verified that the action already occurred</option>
                    <option value="not_applied">I verified that the action did not occur</option>
                  </select>
                </label>
              </>
            )}
            <ErrorMessage error={action.error} />
          </div>
          <div className="dialog-actions">
            <button className="pill-button" type="button" onClick={() => dialog.current?.close()}>
              Cancel
            </button>
            <button className="button" data-variant="primary" disabled={action.busy}>
              Continue
            </button>
          </div>
        </form>
      </dialog>
    </Page>
  );
}

function SaveResolution({ session }: { session: SessionDetails }) {
  const handoff = useResource<Handoff>(`${sessionPath(session.id)}/handoff`, 5000);
  const [open, setOpen] = useState(false),
    dialog = useRef<HTMLDialogElement>(null),
    action = useAction();
  const timeline = useResource<{ entries: TimelineEntry[] }>(
    open ? `${sessionPath(session.id)}/timeline?limit=2000` : null,
    0,
  );
  if (handoff.data?.status !== "done") return null;
  const entries = (timeline.data?.entries ?? []).filter(
    (entry) =>
      entry.at >= handoff.data!.requestedAt && entry.at <= (handoff.data!.resolvedAt ?? ""),
  );
  return (
    <>
      <button
        className="text-button learn-resolution"
        onClick={() => {
          setOpen(true);
          dialog.current?.showModal();
        }}
      >
        Save what resolved this handoff
      </button>
      <dialog className="dialog wide-dialog" ref={dialog} onClose={() => setOpen(false)}>
        <form
          className="dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void action
              .run("/v1/recovery-knowledge", {
                sessionId: session.id,
                handoffId: handoff.data!.id,
                title: string(form, "title"),
                note: string(form, "note"),
                origin: string(form, "origin"),
                selectedSteps: form.getAll("steps").map(Number),
                expiresInDays: 90,
              })
              .then(() => dialog.current?.close())
              .catch(() => {});
          }}
        >
          <div className="dialog-head">
            <h2>Save a recovery lesson</h2>
          </div>
          <div className="dialog-body">
            <p className="field-hint">
              Save notes and only the actions you select. Known credential fields and tokens are
              redacted; keep your notes free of secrets. Suggestions never execute automatically.
            </p>
            <Field label="Title" name="title" value={handoff.data.reason} required />
            <Field
              label="Current site origin"
              name="origin"
              required
              type="url"
              hint="Must match the browser's current site, for example https://example.com."
            />
            <label className="field">
              What resolved it?
              <textarea className="input" name="note" required rows={4} />
            </label>
            <fieldset className="step-picks">
              <legend>Selected resolution actions</legend>
              {entries.map((entry) => (
                <label className="check-row" key={entry.seq}>
                  <input type="checkbox" name="steps" value={entry.seq} />
                  {entry.tool} · {entry.title || when(entry.at)}
                </label>
              ))}
              {!entries.length && (
                <p className="field-hint">
                  No recorded actions in this interval. You can save notes and add reviewed recovery
                  steps later.
                </p>
              )}
            </fieldset>
            <ErrorMessage error={timeline.error || action.error} />
          </div>
          <div className="dialog-actions">
            <button type="button" className="pill-button" onClick={() => dialog.current?.close()}>
              Cancel
            </button>
            <button className="button" data-variant="primary" disabled={action.busy}>
              Save lesson
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}

export function RecoveryPage({ session }: { session?: SessionDetails | null }) {
  const resource = useResource<{ knowledge: Knowledge[] }>("/v1/recovery-knowledge", 5000),
    action = useAction(resource.refresh);
  const [editing, setEditing] = useState<Knowledge | null>(null),
    [accepting, setAccepting] = useState<Knowledge | null>(null),
    dialog = useRef<HTMLDialogElement>(null),
    acceptDialog = useRef<HTMLDialogElement>(null);
  return (
    <Page
      title="Recovery knowledge"
      description="Editable lessons from completed handoffs. Review the exact version before applying a lesson to its original site."
    >
      <ErrorMessage error={resource.error || action.error} />
      {resource.data?.knowledge.length === 0 && (
        <Empty>
          Complete a human handoff, then choose “Save what resolved this handoff” on its browser
          page.
        </Empty>
      )}
      <div className="resource-grid">
        {resource.data?.knowledge.map((item) => (
          <article className="resource-card" key={item.id}>
            <div className="card-heading">
              <h2>{item.title}</h2>
              <span className="badge">
                v{item.version} ·{" "}
                {item.disabled ? "Disabled" : item.stale ? "Needs review" : "Current"}
              </span>
            </div>
            <p>{item.note}</p>
            <p className="field-hint">
              {item.origin} · {item.visibility} · review by {when(item.expiresAt)}
            </p>
            <ol className="recovery-steps">
              {item.steps.map((step, i) => (
                <li key={i}>
                  {step.title || step.tool}
                  {!step.replayable && <small> · needs editing before use</small>}
                </li>
              ))}
            </ol>
            <div className="button-row">
              <button
                className="pill-button"
                onClick={() => {
                  setEditing(item);
                  dialog.current?.showModal();
                }}
              >
                Edit version
              </button>
              <button
                className="pill-button"
                disabled={item.disabled || item.stale}
                onClick={() => {
                  setAccepting(item);
                  acceptDialog.current?.showModal();
                }}
              >
                Review and apply
              </button>
              <button
                className="pill-button"
                disabled={action.busy}
                onClick={() =>
                  void action
                    .run(
                      `/v1/recovery-knowledge/${item.id}?expectedVersion=${item.version}`,
                      undefined,
                      "DELETE",
                    )
                    .catch(() => {})
                }
              >
                Delete
              </button>
            </div>
          </article>
        ))}
      </div>
      <dialog className="dialog wide-dialog" ref={dialog}>
        <ActionForm
          key={`${editing?.id}:${editing?.version}`}
          title="Edit recovery knowledge"
          onSubmit={(form) =>
            action
              .run(
                `/v1/recovery-knowledge/${editing!.id}`,
                {
                  expectedVersion: editing!.version,
                  title: string(form, "title"),
                  note: string(form, "note"),
                  steps: json(string(form, "steps"), []),
                  disabled: form.get("disabled") === "on",
                  expiresInDays: Number(form.get("expiresInDays")),
                },
                "PUT",
              )
              .then(() => dialog.current?.close())
          }
          busy={action.busy}
          error={action.error}
        >
          <Field label="Title" name="title" value={editing?.title} required />
          <Field label="Review again in days" name="expiresInDays" value={90} type="number" />
          <label className="field full">
            Resolution notes
            <textarea className="input" name="note" defaultValue={editing?.note} rows={4} />
          </label>
          <JsonField label="Reviewed recovery steps" name="steps" value={editing?.steps ?? []} />
          <label className="check-row">
            <input name="disabled" type="checkbox" defaultChecked={editing?.disabled} />
            Disable suggestions
          </label>
          <button type="button" className="pill-button" onClick={() => dialog.current?.close()}>
            Cancel
          </button>
        </ActionForm>
      </dialog>
      <dialog className="dialog" ref={acceptDialog}>
        <ActionForm
          key={accepting?.id}
          title={`Apply ${accepting?.title ?? "recovery"} · v${accepting?.version ?? ""}`}
          description="This starts a durable recovery procedure and transfers your control lease to it. Review every step first."
          submit="Apply reviewed steps"
          busy={action.busy}
          error={action.error}
          onSubmit={(form) => {
            const id = string(form, "sessionId");
            return action
              .run(
                `/v1/recovery-knowledge/${accepting!.id}/accept`,
                {
                  expectedVersion: accepting!.version,
                  sessionId: id,
                  accepted: form.get("accepted") === "on",
                  idempotencyKey: crypto.randomUUID(),
                },
                "POST",
                id,
              )
              .then(() => {
                setLocalControl(id, null);
                acceptDialog.current?.close();
              });
          }}
        >
          <Field label="Browser session" name="sessionId" value={session?.id} required />
          <JsonDetails value={accepting?.steps} label="Exact steps to apply" />
          <label className="check-row">
            <input type="checkbox" name="accepted" required />I reviewed and accept this version's
            actions.
          </label>
          <button
            type="button"
            className="pill-button"
            onClick={() => acceptDialog.current?.close()}
          >
            Cancel
          </button>
        </ActionForm>
      </dialog>
    </Page>
  );
}
