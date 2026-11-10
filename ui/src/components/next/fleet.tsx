import { useState } from "react";
import { sessionPath } from "../../api";
import { setLocalControl, useLocalControl, type LocalControl } from "../../control";
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

function FleetBrowser({
  session,
  worker,
  refresh,
}: {
  session: any;
  worker: any;
  refresh: () => void;
}) {
  const control = useLocalControl(session.id),
    action = useAction(refresh),
    [command, setCommand] = useState<any>();
  const current = useResource<any>(
    command?.id ? `/v1/fleet/sessions/${session.id}/commands/${command.id}` : null,
    1500,
  );
  const lease = useResource<any>(`${sessionPath(session.id)}/control`, 3000);
  const take = async () => {
    const value = (await action.run(
      `${sessionPath(session.id)}/control/${lease.data?.lease ? "transfer" : "acquire"}`,
      { mode: "human", ttlMs: 300000 },
    )) as LocalControl;
    setLocalControl(session.id, value);
  };
  return (
    <article className="work-card">
      <div className="card-heading">
        <div>
          <p className="eyebrow">
            {session.engine} · {worker?.location || session.workerId}
          </p>
          <h2>{session.id.slice(0, 12)}</h2>
        </div>
        <span className="status-chip" data-state={session.state}>
          {session.state}
        </span>
      </div>
      <p className="field-hint">
        {when(session.createdAt)} · {session.egressPolicy} network · {session.profileScope}
      </p>
      {session.lastError && <ErrorMessage error={session.lastError} />}
      <ErrorMessage error={action.error || current.error} />
      {!["closed", "closing"].includes(session.state) && (
        <>
          <div className="button-row">
            {control ? (
              <>
                <span>You hold control until {when(control.lease.expiresAt)}</span>
                <button
                  className="pill-button"
                  onClick={() =>
                    void action
                      .run(`${sessionPath(session.id)}/control/release`, {})
                      .then(() => setLocalControl(session.id, null))
                      .catch(() => {})
                  }
                >
                  Release control
                </button>
              </>
            ) : (
              <button className="pill-button" onClick={() => void take().catch(() => {})}>
                Take control
              </button>
            )}
            <button
              className="pill-button"
              disabled={!control || action.busy}
              onClick={() =>
                void action
                  .run(
                    `/v1/fleet/sessions/${session.id}/commands`,
                    { kind: "close", payload: {}, idempotencyKey: crypto.randomUUID() },
                    "POST",
                    session.id,
                  )
                  .then(setCommand)
                  .catch(() => {})
              }
            >
              Close browser
            </button>
          </div>
          <ActionForm
            title="Worker command"
            submit="Send command"
            busy={!control || action.busy}
            error={action.error}
            onSubmit={(form) =>
              action
                .run(
                  `/v1/fleet/sessions/${session.id}/commands`,
                  {
                    kind: string(form, "kind"),
                    payload: json(string(form, "payload")),
                    idempotencyKey: crypto.randomUUID(),
                  },
                  "POST",
                  session.id,
                )
                .then(setCommand)
            }
          >
            <label className="field">
              Supported operation
              <select className="input" name="kind">
                {worker?.capabilities.commands
                  .filter((kind: string) => !["launch", "close"].includes(kind))
                  .map((kind: string) => <option key={kind}>{kind}</option>)}
              </select>
            </label>
            <JsonField name="payload" label="Operation arguments" value={{}} />
          </ActionForm>
        </>
      )}
      {current.data && (
        <>
          <p>
            Command: <strong>{current.data.state}</strong>
          </p>
          <JsonDetails value={current.data} label="Worker result" />
          {current.data.state === "uncertain" && (
            <ActionForm
              title="Reconcile interrupted command"
              description="Verify the real browser before marking whether its effect occurred. This does not blindly replay it."
              busy={action.busy}
              submit="Record verified outcome"
              onSubmit={(form) =>
                action
                  .run(
                    `/v1/fleet/sessions/${session.id}/commands/${current.data.id}/reconcile`,
                    { decision: string(form, "decision"), result: json(string(form, "result")) },
                    "POST",
                    session.id,
                  )
                  .then(() => current.refresh())
              }
            >
              <label className="field">
                Verified outcome
                <select className="input" name="decision">
                  <option value="applied">Effect occurred</option>
                  <option value="not_applied">Effect did not occur</option>
                </select>
              </label>
              <JsonField name="result" label="Verified result" value={{}} />
            </ActionForm>
          )}
        </>
      )}
    </article>
  );
}
export function FleetPage() {
  const workers = useResource<any>("/v1/fleet/workers", 5000),
    sessions = useResource<any>("/v1/fleet/sessions", 3000),
    checkpoints = useResource<any>("/v1/fleet/checkpoints", 5000);
  const [pairing, setPairing] = useState<any>(),
    [selectedWorker, setSelectedWorker] = useState("");
  const action = useAction(() => {
    workers.refresh();
    sessions.refresh();
  });
  const selected = workers.data?.workers.find((worker: any) => worker.id === selectedWorker);
  return (
    <Page
      title="Browser fleet"
      description="Use authenticated workers with measured engine capabilities. Pairing and browser state remain scoped to this workspace."
    >
      <ErrorMessage error={workers.error || sessions.error || checkpoints.error || action.error} />
      <div className="resource-grid">
        {workers.data?.workers.map((worker: any) => (
          <article key={worker.id} className="resource-card">
            <div className="card-heading">
              <h2>{worker.label}</h2>
              <span className="status-chip" data-state={worker.healthy ? "pass" : "fail"}>
                {worker.revoked
                  ? "revoked"
                  : worker.draining
                  ? "draining"
                  : worker.healthy
                  ? "online"
                  : "offline"}
              </span>
            </div>
            <p>
              {worker.location} · {worker.capabilities.device.os} ·{" "}
              {worker.capabilities.device.graphics} graphics
            </p>
            <p>
              {worker.capabilities.engines.join(" / ")} · {worker.activeSessions}/
              {worker.capabilities.capacity} browsers
            </p>
            <p className="field-hint">Last seen {new Date(worker.lastSeen).toLocaleString()}</p>
            <div className="button-row">
              {!worker.revoked &&
                [worker.draining ? "resume" : "drain", "revoke"].map((kind) => (
                  <button
                    className="pill-button"
                    key={kind}
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(`/v1/fleet/workers/${worker.id}/${kind}`, {}).catch(() => {})
                    }
                  >
                    {kind === "resume"
                      ? "Accept work"
                      : kind === "drain"
                      ? "Drain worker"
                      : "Revoke worker"}
                  </button>
                ))}
            </div>
            <JsonDetails value={worker.capabilities} label="Verified capabilities" />
          </article>
        ))}
      </div>
      {workers.data?.workers.length === 0 && (
        <Empty>
          No paired workers. A desktop or Android adapter must advertise its real capabilities
          before taking work.
        </Empty>
      )}
      <ActionForm
        title="Pair a worker"
        description="The short-lived token is shown once. Use it in the worker’s registration command; never place it in a browser URL."
        submit="Create pairing token"
        busy={action.busy}
        error={action.error}
        onSubmit={(form) =>
          action
            .run("/v1/fleet/pairings", {
              label: string(form, "label"),
              location: string(form, "location"),
              engines: form.getAll("engines"),
              profileScope: string(form, "profileScope") || undefined,
            })
            .then(setPairing)
        }
      >
        <Field name="label" label="Worker label" required />
        <Field name="location" label="Location" required />
        <Field name="profileScope" label="Profile namespace (optional)" />
        <fieldset className="step-picks">
          <legend>Allow these real engines</legend>
          {["chromium", "firefox", "webkit", "safari", "android"].map((engine) => (
            <label className="check-row" key={engine}>
              <input name="engines" value={engine} type="checkbox" />
              {engine}
            </label>
          ))}
        </fieldset>
      </ActionForm>
      {pairing && (
        <div className="work-result">
          <p>Copy the pairing token into the trusted worker configuration. It cannot be reused.</p>
          <pre>{JSON.stringify(pairing, null, 2)}</pre>
          <button className="pill-button" onClick={() => setPairing(undefined)}>
            Hide pairing token
          </button>
        </div>
      )}
      <ActionForm
        title="Start a fleet browser"
        submit="Start on worker"
        busy={action.busy}
        error={action.error}
        onSubmit={(form) =>
          action
            .run("/v1/fleet/sessions", {
              engine: string(form, "engine"),
              workerId: selectedWorker || undefined,
              location: string(form, "location") || undefined,
              egressPolicy: string(form, "egressPolicy"),
              checkpointId: string(form, "checkpointId") || undefined,
              headless: form.get("headless") === "on",
            })
            .then(() => sessions.refresh())
        }
      >
        <label className="field">
          Worker
          <select
            className="input"
            value={selectedWorker}
            onChange={(event) => setSelectedWorker(event.target.value)}
          >
            <option value="">Any available matching worker</option>
            {workers.data?.workers
              .filter((worker: any) => worker.healthy && !worker.revoked && !worker.draining)
              .map((worker: any) => (
                <option key={worker.id} value={worker.id}>
                  {worker.label} · {worker.location}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          Engine
          <select className="input" name="engine">
            {(
              selected?.capabilities.engines ?? [
                "chromium",
                "firefox",
                "webkit",
                "safari",
                "android",
              ]
            ).map((engine: string) => (
              <option key={engine}>{engine}</option>
            ))}
          </select>
        </label>
        <Field name="location" label="Required location (optional)" />
        <label className="field">
          Network
          <select name="egressPolicy" className="input">
            <option value="standard">Standard</option>
            <option value="strict">Strict route required</option>
          </select>
        </label>
        <label className="field">
          Portable checkpoint
          <select className="input" name="checkpointId">
            <option value="">Fresh browser</option>
            {checkpoints.data?.checkpoints.map((checkpoint: any) => (
              <option key={checkpoint.id} value={checkpoint.id}>
                {checkpoint.engine} · {when(checkpoint.createdAt)}
              </option>
            ))}
          </select>
        </label>
        <label className="check-row">
          <input name="headless" type="checkbox" />
          Headless (only if supported)
        </label>
      </ActionForm>
      <div className="work-list">
        {sessions.data?.sessions.map((session: any) => (
          <FleetBrowser
            key={session.id}
            session={session}
            worker={workers.data?.workers.find((worker: any) => worker.id === session.workerId)}
            refresh={sessions.refresh}
          />
        ))}
      </div>
    </Page>
  );
}
