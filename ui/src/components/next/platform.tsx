import { useState } from "react";
import { apiUrl, request, sessionPath, type SessionDetails } from "../../api";
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

export function PlatformPage({ session }: { session?: SessionDetails | null }) {
  const [tab, setTab] = useState("checkpoints"),
    [result, setResult] = useState<any>(),
    [commandSession, setCommandSession] = useState(session?.id || "");
  const rows = useResource<any>(
      tab === "checkpoints" ? "/v1/checkpoints" : tab === "budgets" ? "/v1/budgets" : null,
      5000,
    ),
    action = useAction(rows.refresh);
  const show = async (path: string) => {
    try {
      setResult(await request(path));
    } catch (error) {
      action.setError(String(error));
    }
  };
  return (
    <Page
      title="Browser operations"
      description="Checkpoint browser state, diagnose failures, run bounded commands, and allocate capacity."
    >
      <div className="history-tabs" role="tablist">
        {["checkpoints", "diagnostics", "commands", "budgets"].map((value) => (
          <button
            key={value}
            role="tab"
            aria-selected={tab === value}
            onClick={() => {
              setTab(value);
              setResult(undefined);
            }}
          >
            {value.charAt(0).toUpperCase() + value.slice(1)}
          </button>
        ))}
      </div>
      <ErrorMessage error={rows.error || action.error} />
      {tab === "checkpoints" && (
        <>
          <ActionForm
            title="Save a named checkpoint"
            description="Steel safely parks the browser to flush its profile. A branch copies local browser state; external website actions are not undone."
            submit="Save checkpoint"
            busy={action.busy}
            error={action.error}
            onSubmit={(form) =>
              action
                .run(`${sessionPath(string(form, "sessionId"))}/checkpoints`, {
                  name: string(form, "name"),
                  retentionDays: Number(string(form, "retentionDays")),
                })
                .then(setResult)
            }
          >
            <Field name="sessionId" label="Browser session" value={session?.id} required />
            <Field name="name" label="Checkpoint name" required />
            <Field name="retentionDays" label="Keep for days" value={30} type="number" required />
          </ActionForm>
          <div className="resource-grid">
            {rows.data?.checkpoints.map((checkpoint: any) => (
              <article className="resource-card" key={checkpoint.id}>
                <h2>{checkpoint.name}</h2>
                <p>
                  {when(checkpoint.createdAt)} · {Math.ceil(checkpoint.bytes / 1048576)} MB
                </p>
                <p className="field-hint">Expires {when(checkpoint.expiresAt)}</p>
                <div className="button-row">
                  <button
                    className="pill-button"
                    disabled={action.busy}
                    onClick={() =>
                      void action
                        .run(`/v1/checkpoints/${checkpoint.id}/branch`, {})
                        .then(setResult)
                        .catch(() => {})
                    }
                  >
                    Branch into new browser
                  </button>
                  <button
                    className="pill-button"
                    disabled={action.busy}
                    onClick={() =>
                      void action
                        .run(`/v1/checkpoints/${checkpoint.id}`, undefined, "DELETE")
                        .catch(() => {})
                    }
                  >
                    Delete
                  </button>
                </div>
                <JsonDetails value={checkpoint} label="Integrity & source" />
              </article>
            ))}
          </div>
          {rows.data?.checkpoints.length === 0 && <Empty>No retained checkpoints.</Empty>}
        </>
      )}
      {tab === "diagnostics" && (
        <>
          <ActionForm
            title="Diagnose a browser"
            description="Read-only bounded probes distinguish evidence from untested possibilities. Recovery always remains explicit."
            submit="Run diagnosis"
            busy={action.busy}
            error={action.error}
            onSubmit={(form) =>
              action.run(`${sessionPath(string(form, "sessionId"))}/diagnose`, {}).then(setResult)
            }
          >
            <Field name="sessionId" label="Browser session" value={session?.id} required />
          </ActionForm>
          {result?.observations && (
            <article className="work-card">
              <h2>Diagnosis · {when(result.at)}</h2>
              <ul className="check-results">
                {result.observations.map((check: any) => (
                  <li key={check.component}>
                    <span className="status-chip" data-state={check.status}>
                      {check.status}
                    </span>
                    <strong>{check.component}</strong>
                    <span>{check.evidence}</span>
                    <small>{check.confidence} confidence</small>
                  </li>
                ))}
              </ul>
              {result.recovery?.map((item: any, index: number) => (
                <p key={index}>
                  <strong>{item.action.replaceAll("_", " ")}</strong> · {item.reason}
                </p>
              ))}
              <a
                className="pill-button"
                href={apiUrl(`/v1/diagnostics/${result.id}/bundle`)}
                download
              >
                Download redacted diagnosis
              </a>
            </article>
          )}
        </>
      )}
      {tab === "commands" && (
        <>
          <ActionForm
            title="Run a command batch"
            description="Requires this tab’s current control lease. Batches stop at the first failure and retain execution status; cancellation does not undo completed actions."
            submit="Execute batch"
            busy={action.busy}
            error={action.error}
            onSubmit={(form) => {
              const id = string(form, "sessionId");
              setCommandSession(id);
              return action
                .run(`${sessionPath(id)}/commands`, json(string(form, "commands")), "POST", id)
                .then(setResult);
            }}
          >
            <Field name="sessionId" label="Browser session" value={session?.id} required />
            <JsonField
              name="commands"
              label="Command request"
              value={{ commands: [{ command: "snapshot" }] }}
            />
            <p className="field-hint">
              Use the command schema for exact operations and arguments.{" "}
              <a
                href={apiUrl(
                  `${sessionPath(commandSession || session?.id || "session")}/commands/schema`,
                )}
                target="_blank"
                rel="noreferrer"
              >
                Open schema ↗
              </a>
            </p>
          </ActionForm>
          {result?.executionId && (
            <div className="button-row">
              <button
                className="pill-button"
                onClick={() =>
                  void show(
                    `${sessionPath(commandSession)}/commands/executions/${result.executionId}`,
                  )
                }
              >
                Refresh execution
              </button>
              <button
                className="pill-button"
                onClick={() =>
                  void action
                    .run(
                      `${sessionPath(commandSession)}/commands/executions/${
                        result.executionId
                      }/cancel`,
                      {},
                    )
                    .then(setResult)
                    .catch(() => {})
                }
              >
                Cancel execution
              </button>
            </div>
          )}
        </>
      )}
      {tab === "budgets" && rows.data && (
        <>
          <p className="field-hint">
            {rows.data.active.length} active browsers. Park all browsers before changing policy.
            Client limits require verified identity.
          </p>
          <ActionForm
            key={JSON.stringify(rows.data.config)}
            title="Capacity policy"
            submit="Save capacity policy"
            busy={action.busy}
            error={action.error}
            onSubmit={(form) =>
              action
                .run(
                  "/v1/budgets",
                  {
                    defaultMaxConcurrent: Number(string(form, "defaultMaxConcurrent")),
                    clients: json(string(form, "clients")),
                    sites: json(string(form, "sites")),
                  },
                  "PUT",
                )
                .then(setResult)
            }
          >
            <Field
              name="defaultMaxConcurrent"
              label="Default browsers per client"
              value={rows.data.config.defaultMaxConcurrent}
              type="number"
              required
            />
            <JsonField
              name="clients"
              label="Client limits and queue weights"
              value={rows.data.config.clients}
            />
            <JsonField
              name="sites"
              label="Exact site origin limits"
              value={rows.data.config.sites}
            />
          </ActionForm>
          <JsonDetails
            value={{ active: rows.data.active, sites: rows.data.sites }}
            label="Current allocation"
          />
        </>
      )}
      {result !== undefined && (
        <div className="work-result">
          {result.id && result.status === "parked" && (
            <a href={`?session=${result.id}`}>Open checkpoint branch ↗</a>
          )}
          <JsonDetails value={result} label="Operation result" />
        </div>
      )}
    </Page>
  );
}
