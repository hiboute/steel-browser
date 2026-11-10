import { useRef, useState } from "react";
import { apiUrl, request, type SessionDetails } from "../../api";
import { setLocalControl } from "../../control";
import { useResource } from "../../hooks";
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
} from "./common";

type Row = {
  id: string;
  name?: string;
  description?: string;
  version?: number;
  ownerId: string;
  createdAt: string;
  updatedAt?: string;
  status?: string;
  [key: string]: any;
};
const initialSteps = [
  {
    id: "open",
    kind: "commands",
    input: { commands: [{ command: "navigate", url: { $input: "url" } }] },
  },
  {
    id: "verify",
    kind: "assert",
    assertion: {
      id: "title",
      label: "Page has the expected title",
      command: { commands: [{ command: "get", what: "title" }] },
      path: "results.0.value",
      operator: "contains",
      expected: { $input: "expectedTitle" },
      evidence: "value",
    },
  },
];
const initialInput = {
  type: "object",
  required: ["url", "expectedTitle"],
  additionalProperties: false,
  properties: { url: { type: "string" }, expectedTitle: { type: "string" } },
};

export function AutomationPage({ session }: { session?: SessionDetails | null }) {
  const [tab, setTab] = useState("procedures"),
    [editing, setEditing] = useState<Row | null>(null),
    [running, setRunning] = useState<Row | null>(null),
    [detail, setDetail] = useState<unknown>(),
    [schedule, setSchedule] = useState<Row | null>(null);
  const editor = useRef<HTMLDialogElement>(null),
    runner = useRef<HTMLDialogElement>(null),
    scheduler = useRef<HTMLDialogElement>(null);
  const resources = useResource<Record<string, Row[]>>(
    `/v1/${
      tab === "schedules" ? "procedure-schedules" : tab === "replays" ? "regression-replays" : tab
    }`,
    3000,
  );
  const rows = Object.values(resources.data ?? {})[0] ?? [],
    action = useAction(resources.refresh);
  const show = async (path: string) => {
    try {
      setDetail(await request(path));
    } catch (error) {
      action.setError(String(error));
    }
  };
  const saveProcedure = async (form: FormData) => {
    const body = {
      ...(editing ? { id: editing.id, expectedVersion: editing.version } : {}),
      name: string(form, "name"),
      description: string(form, "description"),
      inputSchema: json(string(form, "inputSchema")),
      steps: json(string(form, "steps"), []),
      recovery: json(string(form, "recovery"), []),
    };
    await action.run(
      editing ? `/v1/procedures/${editing.id}` : "/v1/procedures",
      body,
      editing ? "PUT" : "POST",
    );
    editor.current?.close();
  };
  return (
    <Page
      title="Procedures & tasks"
      description="Versioned routines, durable progress, exact-content reviews, and evidence-backed results."
      action={
        <button
          className="button"
          data-variant="primary"
          onClick={() => {
            setEditing(null);
            editor.current?.showModal();
          }}
        >
          New procedure
        </button>
      }
    >
      <div className="history-tabs" role="tablist">
        {["procedures", "runs", "reviews", "receipts", "schedules", "replays"].map((name) => (
          <button
            role="tab"
            key={name}
            aria-selected={tab === name}
            onClick={() => {
              setTab(name);
              setDetail(undefined);
            }}
          >
            {
              (
                {
                  procedures: "Procedures",
                  runs: "Tasks",
                  reviews: "Reviews",
                  receipts: "Results",
                  schedules: "Triggers",
                  replays: "Regression replay",
                } as Record<string, string>
              )[name]
            }
          </button>
        ))}
      </div>
      <ErrorMessage error={resources.error || action.error} />
      {tab === "schedules" && (
        <button
          className="pill-button"
          onClick={() => {
            setSchedule(null);
            scheduler.current?.showModal();
          }}
        >
          Add trigger
        </button>
      )}
      {resources.data && !rows.length && (
        <Empty>
          {tab === "procedures"
            ? "Save a routine to make a successful browser task repeatable."
            : `No ${tab} yet.`}
        </Empty>
      )}
      <div className="resource-grid">
        {rows.map((row) => (
          <article className="resource-card" key={row.id}>
            <div className="card-heading">
              <h2>
                {row.name ||
                  row.summary ||
                  row.proposal?.summary ||
                  row.metadata?.name ||
                  row.id.slice(0, 12)}
              </h2>
              <span className="badge">
                {row.version ? `v${row.version}` : row.status || row.trigger?.kind}
              </span>
            </div>
            {row.description && <p>{row.description}</p>}
            <p className="field-hint">
              {when(row.updatedAt || row.createdAt)}
              {row.sessionId && (
                <>
                  {" "}
                  · <a href={`?session=${row.sessionId}`}>Open browser</a>
                </>
              )}
            </p>
            {tab === "runs" && (
              <>
                <p>
                  Step {Math.min((row.cursor ?? 0) + 1, row.steps?.length ?? 0)} of{" "}
                  {row.steps?.length ?? 0}
                </p>
                {row.pauseReason && <p>{row.pauseReason}</p>}
                <JsonDetails value={row.results} label="Step results" />
              </>
            )}
            {tab === "reviews" && (
              <div className="review-proposal">
                <p>Destination: {row.proposal?.destination}</p>
                <JsonDetails value={row.proposal} label="Exact action and attachments" />
                <JsonDetails value={row.preparedSnapshot} label="Prepared page state" />
              </div>
            )}
            {tab === "receipts" && (
              <>
                <p>{row.summary}</p>
                {row.assertions?.map((check: any) => (
                  <div className="assertion-row" key={check.id}>
                    <span className="badge">{check.status}</span>
                    <span>{check.label}</span>
                    {check.evidence?.artifactId && (
                      <a
                        href={apiUrl(`/v1/workflow-evidence/${check.evidence.artifactId}`)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Evidence ↗
                      </a>
                    )}
                  </div>
                ))}
              </>
            )}
            {tab === "schedules" && (
              <p>
                Next: {when(row.nextRunAt)} · {row.enabled ? "Enabled" : "Paused"}
              </p>
            )}
            {tab === "replays" && <JsonDetails value={row} label="Outcome comparison" />}
            <div className="button-row">
              {tab === "procedures" && (
                <>
                  <button
                    className="pill-button"
                    onClick={() => {
                      setRunning(row);
                      runner.current?.showModal();
                    }}
                  >
                    Run version
                  </button>
                  <button
                    className="pill-button"
                    onClick={() => {
                      setEditing(row);
                      editor.current?.showModal();
                    }}
                  >
                    Edit
                  </button>
                  <button
                    className="pill-button"
                    onClick={() => void show(`/v1/procedures/${row.id}/versions`)}
                  >
                    Versions
                  </button>
                  <button
                    className="pill-button"
                    disabled={action.busy}
                    onClick={() =>
                      void action
                        .run(`/v1/procedures/${row.id}`, undefined, "DELETE")
                        .catch(() => {})
                    }
                  >
                    Delete
                  </button>
                </>
              )}
              {tab === "runs" && (
                <>
                  {["paused", "uncertain", "failed"].includes(row.status ?? "") && (
                    <a className="pill-button" href="?view=inbox">
                      Review and resume in inbox
                    </a>
                  )}
                  {!["completed", "cancelled", "failed"].includes(row.status ?? "") && (
                    <button
                      className="pill-button"
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(`/v1/runs/${row.id}/cancel`, {}).catch(() => {})
                      }
                    >
                      Cancel task
                    </button>
                  )}
                  <button
                    className="pill-button"
                    onClick={() => void show(`/v1/receipts/${row.id}`)}
                  >
                    Verify result
                  </button>
                </>
              )}
              {tab === "reviews" &&
                row.status === "pending" &&
                ["approve", "reject"].map((decision) => (
                  <button
                    key={decision}
                    className="pill-button"
                    disabled={action.busy}
                    onClick={() =>
                      void action
                        .run(`/v1/reviews/${row.id}/decision`, {
                          decision,
                          contentHash: row.contentHash,
                        })
                        .catch(() => {})
                    }
                  >
                    {decision === "approve" ? "Approve exact action" : "Reject"}
                  </button>
                ))}
              {tab === "schedules" && (
                <>
                  <button
                    className="pill-button"
                    onClick={() => {
                      setSchedule(row);
                      scheduler.current?.showModal();
                    }}
                  >
                    Edit
                  </button>
                  <button
                    className="pill-button"
                    onClick={() => void show(`/v1/procedure-schedules/${row.id}/history`)}
                  >
                    History
                  </button>
                  <button
                    className="pill-button"
                    disabled={action.busy}
                    onClick={() =>
                      void action
                        .run(`/v1/procedure-schedules/${row.id}`, undefined, "DELETE")
                        .catch(() => {})
                    }
                  >
                    Delete
                  </button>
                </>
              )}
              {tab === "receipts" && (
                <button
                  className="pill-button"
                  onClick={() => void show(`/v1/receipts/${row.runId}`)}
                >
                  Refresh evidence
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      {detail !== undefined && (
        <div className="work-result">
          <button className="pill-button" onClick={() => setDetail(undefined)}>
            Close detail
          </button>
          <pre>{JSON.stringify(detail, null, 2)}</pre>
        </div>
      )}
      {tab === "replays" && (
        <ActionForm
          title="Run a candidate comparison"
          description="Uses a fresh browser restricted to configured owned test origins. Mutation replay must be explicitly enabled."
          busy={action.busy}
          error={action.error}
          submit="Start comparison"
          onSubmit={(form) =>
            action.run("/v1/regression-replays", {
              baselineRunId: string(form, "baselineRunId"),
              inputs: json(string(form, "inputs")),
              candidate: {
                label: string(form, "label"),
                sessionOptions: json(string(form, "sessionOptions")),
              },
              allowedOrigins: string(form, "origins")
                .split(/\s*,\s*/)
                .filter(Boolean),
              allowMutations: form.get("allowMutations") === "on",
              idempotencyKey: crypto.randomUUID(),
            })
          }
        >
          <Field name="baselineRunId" label="Verified baseline run" required />
          <Field name="label" label="Candidate label" required />
          <Field
            name="origins"
            label="Owned test origins"
            hint="Comma-separated exact origins."
            required
          />
          <JsonField name="inputs" label="Pinned inputs" value={{}} />
          <JsonField
            name="sessionOptions"
            label="Candidate browser settings"
            value={{ compatibilityMode: "native" }}
          />
          <label className="check-row">
            <input name="allowMutations" type="checkbox" />
            Allow this replay to perform reviewed mutations on the owned fixtures.
          </label>
        </ActionForm>
      )}
      <dialog className="dialog wide-dialog" ref={editor}>
        <ActionForm
          key={`${editing?.id}:${editing?.version}`}
          title={editing ? `Edit ${editing.name} · new version` : "New reusable procedure"}
          description="Inputs use {$input: 'name'} references. Add explicit assertions and optional exact-action review points to the steps."
          onSubmit={saveProcedure}
          error={action.error}
          busy={action.busy}
        >
          <Field name="name" label="Name" value={editing?.name} required />
          <Field name="description" label="Description" value={editing?.description} />
          <JsonField
            name="inputSchema"
            label="Input schema"
            value={editing?.inputSchema ?? initialInput}
          />
          <JsonField
            name="steps"
            label="Ordered steps and outcome checks"
            value={editing?.steps ?? initialSteps}
            rows={14}
          />
          <JsonField
            name="recovery"
            label="Recovery instructions"
            value={editing?.recovery ?? []}
          />
          <button type="button" className="pill-button" onClick={() => editor.current?.close()}>
            Cancel
          </button>
        </ActionForm>
      </dialog>
      <dialog className="dialog" ref={runner}>
        <ActionForm
          key={running?.id}
          title={`Run ${running?.name ?? "procedure"} · v${running?.version ?? ""}`}
          description="Using an existing browser transfers its current control lease to the task. Leave the session blank to start a new browser."
          submit="Start task"
          error={action.error}
          busy={action.busy}
          onSubmit={async (form) => {
            const id = string(form, "sessionId");
            const run = await action.run(
              `/v1/procedures/${running!.id}/run`,
              {
                version: running!.version,
                inputs: json(string(form, "inputs")),
                ...(id ? { sessionId: id } : { sessionOptions: {} }),
                idempotencyKey: crypto.randomUUID(),
              },
              "POST",
              id,
            );
            if (id) setLocalControl(id, null);
            setDetail(run);
            runner.current?.close();
            setTab("runs");
          }}
        >
          <Field name="sessionId" label="Existing browser (optional)" value={session?.id} />
          <JsonField name="inputs" label="Procedure inputs" value={{}} />
          <button type="button" className="pill-button" onClick={() => runner.current?.close()}>
            Cancel
          </button>
        </ActionForm>
      </dialog>
      <dialog className="dialog wide-dialog" ref={scheduler}>
        <ActionForm
          key={schedule?.id ?? "new"}
          title={schedule ? "Edit trigger" : "Schedule a procedure"}
          description="Pin a procedure version. Webhook creation returns a secret once; saving a webhook trigger rotates it."
          error={action.error}
          busy={action.busy}
          onSubmit={async (form) => {
            const result = await action.run(
              schedule ? `/v1/procedure-schedules/${schedule.id}` : "/v1/procedure-schedules",
              {
                ...(schedule ? { id: schedule.id } : {}),
                name: string(form, "name"),
                procedureId: string(form, "procedureId"),
                version: Number(form.get("version")),
                inputs: json(string(form, "inputs")),
                trigger: json(string(form, "trigger")),
                sessionOptions: json(string(form, "sessionOptions")),
                enabled: form.get("enabled") === "on",
                missedRun: string(form, "missedRun"),
                maxLatenessSeconds: Number(form.get("maxLatenessSeconds")),
                maxConcurrent: Number(form.get("maxConcurrent")),
                deadlineSeconds: Number(form.get("deadlineSeconds")),
              },
              schedule ? "PUT" : "POST",
            );
            setDetail(result);
            scheduler.current?.close();
          }}
        >
          <Field name="name" label="Name" value={schedule?.name} required />
          <Field name="procedureId" label="Procedure ID" value={schedule?.procedureId} required />
          <Field
            name="version"
            label="Pinned version"
            type="number"
            value={schedule?.version ?? 1}
            required
          />
          <Field
            name="maxConcurrent"
            label="Maximum parallel runs"
            type="number"
            value={schedule?.maxConcurrent ?? 1}
          />
          <Field
            name="deadlineSeconds"
            label="Run deadline (seconds)"
            type="number"
            value={schedule?.deadlineSeconds ?? 3600}
          />
          <Field
            name="maxLatenessSeconds"
            label="Maximum lateness (seconds)"
            type="number"
            value={schedule?.maxLatenessSeconds ?? 3600}
          />
          <label className="field">
            Missed runs
            <select name="missedRun" className="input" defaultValue={schedule?.missedRun ?? "skip"}>
              <option value="skip">Skip</option>
              <option value="run_once">Run once when available</option>
            </select>
          </label>
          <JsonField
            name="trigger"
            label="Trigger: daily, interval, webhook or watcher"
            value={
              schedule?.trigger ?? {
                kind: "daily",
                at: "09:00",
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              }
            }
          />
          <JsonField name="inputs" label="Procedure inputs" value={schedule?.inputs ?? {}} />
          <JsonField
            name="sessionOptions"
            label="New browser settings"
            value={schedule?.sessionOptions ?? {}}
          />
          <label className="check-row">
            <input name="enabled" type="checkbox" defaultChecked={schedule?.enabled ?? true} />
            Enabled
          </label>
          <button type="button" className="pill-button" onClick={() => scheduler.current?.close()}>
            Cancel
          </button>
        </ActionForm>
      </dialog>
    </Page>
  );
}
