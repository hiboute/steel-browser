import { useRef, useState } from "react";
import { sessionPath, type SessionDetails } from "../../api";
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
type RecordData = {
  name: string;
  revision: number;
  settings: Record<string, unknown>;
  bindings?: unknown;
  origin?: string;
  identityProfile?: string;
  permissions?: string[];
  extensions?: string[];
  interaction?: unknown;
  updatedAt?: string;
  [key: string]: any;
};

export function IdentityPage({ session }: { session?: SessionDetails | null }) {
  const [tab, setTab] = useState("inspect"),
    [editing, setEditing] = useState<RecordData | null>(null),
    [detail, setDetail] = useState<any>(),
    [baseline, setBaseline] = useState("");
  const editor = useRef<HTMLDialogElement>(null),
    path = session ? sessionPath(session.id) : null;
  const profiles = useResource<{ profiles: RecordData[] }>(
    tab === "profiles" ? "/v1/identity-profiles" : tab === "sites" ? "/v1/site-profiles" : null,
    5000,
  );
  const mobile = useResource<{ profiles: any[]; realDevice: unknown }>(
    tab === "mobile" ? "/v1/mobile-profiles" : null,
    0,
  );
  const labs = useResource<{ reports: any[] }>(
    tab === "lab" ? "/v1/compatibility/runs" : null,
    5000,
  );
  const scorecards = useResource<{ configured: string; defaultMode: string; scorecards: any[] }>(
    tab === "scorecard" ? "/v1/identity/scorecards" : null,
    15000,
  );
  const inspector = useResource<any>(tab === "inspect" && path ? `${path}/identity` : null, 0);
  const friction = useResource<any>(tab === "inspect" && path ? `${path}/friction` : null, 5000);
  const continuity = useResource<any>(
    tab === "inspect" && path ? `${path}/continuity` : null,
    10000,
  );
  const action = useAction(() => {
    profiles.refresh();
    labs.refresh();
    scorecards.refresh();
    inspector.refresh();
    friction.refresh();
    continuity.refresh();
  });
  const inspectAction = async (endpoint: string, body?: unknown) =>
    setDetail(await action.run(endpoint, body, "POST", session?.id));
  const save = async (form: FormData) => {
    const name = string(form, "name"),
      common = {
        ...(editing ? { expectedRevision: editing.revision } : {}),
        settings: json(string(form, "settings")),
      };
    const body =
      tab === "sites"
        ? {
            ...common,
            origin: string(form, "origin"),
            identityProfile: string(form, "identityProfile") || undefined,
            permissions: string(form, "permissions")
              .split(/\s*,\s*/)
              .filter(Boolean),
            extensions: string(form, "extensions")
              .split(/\s*,\s*/)
              .filter(Boolean),
            interaction: json(string(form, "interaction")),
          }
        : { ...common, bindings: json(string(form, "bindings")) };
    await action.run(
      `/v1/${tab === "sites" ? "site" : "identity"}-profiles/${encodeURIComponent(name)}`,
      body,
      "PUT",
    );
    editor.current?.close();
  };
  return (
    <Page
      title="Identity & compatibility"
      description="Measure the browser you actually run, keep coherent versions, and investigate site friction."
      action={
        tab === "profiles" || tab === "sites" ? (
          <button
            className="button"
            data-variant="primary"
            onClick={() => {
              setEditing(null);
              editor.current?.showModal();
            }}
          >
            New {tab === "sites" ? "site" : "identity"} profile
          </button>
        ) : undefined
      }
    >
      <div className="history-tabs" role="tablist">
        {["inspect", "profiles", "sites", "mobile", "lab", "scorecard"].map((value) => (
          <button
            key={value}
            role="tab"
            aria-selected={tab === value}
            onClick={() => {
              setTab(value);
              setDetail(undefined);
            }}
          >
            {
              (
                {
                  inspect: "This browser",
                  profiles: "Identity profiles",
                  sites: "Site profiles",
                  mobile: "Mobile fidelity",
                  lab: "Compatibility lab",
                } as Record<string, string>
              )[value]
            }
          </button>
        ))}
      </div>
      <ErrorMessage
        error={
          action.error ||
          profiles.error ||
          mobile.error ||
          labs.error ||
          scorecards.error ||
          inspector.error ||
          friction.error ||
          continuity.error
        }
      />
      {tab === "inspect" &&
        (!session ? (
          <Empty>Select a browser to inspect its measured identity and network continuity.</Empty>
        ) : (
          <>
            <div className="button-row">
              <a className="pill-button" href={`?session=${session.id}`}>
                Open {session.name || "browser"}
              </a>
              <button className="pill-button" onClick={inspector.refresh}>
                Measure identity
              </button>
              <button
                className="pill-button"
                disabled={action.busy}
                onClick={() => void inspectAction(`${path}/friction/scan`, {}).catch(() => {})}
              >
                Check for friction
              </button>
              <button
                className="pill-button"
                disabled={action.busy}
                onClick={() => void inspectAction(`${path}/egress-diagnostics`, {}).catch(() => {})}
              >
                Check browser egress
              </button>
              <button
                className="pill-button"
                disabled={action.busy}
                onClick={() => void inspectAction(`${path}/diagnose`, {}).catch(() => {})}
              >
                Diagnose failure
              </button>
            </div>
            {inspector.data && (
              <>
                <div className="stat-grid">
                  <div className="stat-card">
                    <span>Actual browser</span>
                    <strong className="small-stat">{inspector.data.browserVersion}</strong>
                  </div>
                  <div className="stat-card">
                    <span>Compatibility mode</span>
                    <strong className="small-stat">{inspector.data.patches?.mode}</strong>
                  </div>
                  <div className="stat-card">
                    <span>JavaScript observation</span>
                    <strong className="small-stat">{inspector.data.observed?.status}</strong>
                  </div>
                  <div className="stat-card">
                    <span>HTTP collector</span>
                    <strong className="small-stat">{inspector.data.collector?.status}</strong>
                  </div>
                </div>
                {inspector.data.issues?.map((issue: any, i: number) => (
                  <p className={`diagnostic ${issue.severity}`} key={i}>
                    <b>{issue.code}</b> {issue.message}
                  </p>
                ))}
                <div className="resource-grid">
                  <JsonDetails value={inspector.data.requested} label="Requested identity" />
                  <JsonDetails value={inspector.data.observed} label="Measured browser identity" />
                  <JsonDetails value={inspector.data.collector} label="Observed HTTP headers" />
                  <JsonDetails
                    value={inspector.data.patches}
                    label="Active compatibility patches and fallbacks"
                  />
                </div>
                <p className="field-hint">{inspector.data.limits?.join(" · ")}</p>
              </>
            )}
            {friction.data && (
              <div className="work-card">
                <h2>Site friction · {friction.data.status}</h2>
                <p>{friction.data.finding?.reason || "No friction finding reported."}</p>
                {friction.data.finding && (
                  <p className="field-hint">
                    {friction.data.finding.kind} · confidence {friction.data.finding.confidence}
                  </p>
                )}
                {friction.data.handoffId && (
                  <a href={`?session=${session.id}`}>Open human handoff ↗</a>
                )}
              </div>
            )}
            {continuity.data && (
              <div className="work-card">
                <h2>Account network continuity · {continuity.data.status}</h2>
                <JsonDetails value={continuity.data} label="Network drift evidence" />
                {continuity.data.confirmationToken &&
                  ["drift", "unavailable"].includes(continuity.data.status) && (
                    <button
                      className="pill-button"
                      disabled={action.busy}
                      onClick={() =>
                        void inspectAction(`${path}/continuity/confirm`, {
                          token: continuity.data.confirmationToken,
                        }).catch(() => {})
                      }
                    >
                      Accept this observed network change
                    </button>
                  )}
              </div>
            )}
          </>
        ))}
      {(tab === "profiles" || tab === "sites") && (
        <>
          {profiles.data?.profiles.length === 0 && (
            <Empty>
              No saved profiles yet. Capture a known working browser or define its settings.
            </Empty>
          )}
          <div className="resource-grid">
            {profiles.data?.profiles.map((profile) => (
              <article className="resource-card" key={profile.name}>
                <div className="card-heading">
                  <h2>{profile.name}</h2>
                  <span className="badge">revision {profile.revision}</span>
                </div>
                <p>{profile.origin || profile.browserVersion || "Uncaptured browser version"}</p>
                <p className="field-hint">{when(profile.updatedAt)}</p>
                <JsonDetails value={profile.settings} label="Saved settings" />
                <div className="button-row">
                  <button
                    className="pill-button"
                    onClick={() => {
                      setEditing(profile);
                      editor.current?.showModal();
                    }}
                  >
                    Edit
                  </button>
                  {tab === "profiles" && (
                    <>
                      <button
                        className="pill-button"
                        disabled={!session || action.busy}
                        onClick={() =>
                          void inspectAction(`/v1/identity-profiles/${profile.name}/capture`, {
                            sessionId: session?.id,
                            expectedRevision: profile.revision,
                          }).catch(() => {})
                        }
                      >
                        Capture current browser
                      </button>
                      <button
                        className="pill-button"
                        disabled={action.busy}
                        onClick={() =>
                          void inspectAction(`/v1/identity-profiles/${profile.name}/migrate`, {
                            expectedRevision: profile.revision,
                            compatibilityMode: profile.settings.compatibilityMode,
                          }).catch(() => {})
                        }
                      >
                        Migrate browser version
                      </button>
                      <button
                        className="pill-button"
                        disabled={action.busy}
                        onClick={() =>
                          void inspectAction(
                            `/v1/identity-profiles/${profile.name}/continuity/reset`,
                            {},
                          ).catch(() => {})
                        }
                      >
                        Reset network history
                      </button>
                    </>
                  )}
                  {tab === "sites" && (
                    <button
                      className="pill-button"
                      disabled={!session || action.busy}
                      onClick={() =>
                        void inspectAction(`/v1/site-profiles/${profile.name}/success`, {
                          sessionId: session?.id,
                        }).catch(() => {})
                      }
                    >
                      Record current success
                    </button>
                  )}
                  <button
                    className="pill-button"
                    disabled={action.busy}
                    onClick={() =>
                      void action
                        .run(
                          `/v1/${tab === "sites" ? "site" : "identity"}-profiles/${profile.name}`,
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
        </>
      )}
      {tab === "mobile" && (
        <>
          <div className="resource-grid">
            {mobile.data?.profiles.map((profile) => (
              <article className="resource-card" key={profile.id}>
                <h2>{profile.id}</h2>
                <JsonDetails value={profile} label="Device dimensions, touch and fidelity" />
              </article>
            ))}
          </div>
          {mobile.data && (
            <JsonDetails
              value={mobile.data.realDevice}
              label="Real-device capabilities and registration"
            />
          )}
        </>
      )}
      {tab === "scorecard" && (
        <>
          <div className="filter-bar">
            <p className="field-hint">
              A browser that asks for no identity gets{" "}
              <strong>{scorecards.data?.defaultMode}</strong>
              {scorecards.data?.configured === "auto"
                ? ", the best scoring mode of the latest run."
                : `, set by configuration (${scorecards.data?.configured ?? "…"}).`}{" "}
              Each night Steel opens one browser per mode and counts what a site could notice: 100
              means nothing contradicts.
            </p>
            <button
              className="button"
              disabled={action.busy}
              onClick={() =>
                void action
                  .run("/v1/identity/scorecard/run", {})
                  .then(setDetail)
                  .catch(() => {})
              }
            >
              {action.busy ? "Measuring…" : "Measure now"}
            </button>
          </div>
          {!scorecards.data?.scorecards.length && (
            <Empty>No measurement yet. The first one runs shortly after a start.</Empty>
          )}
          <div className="resource-grid">
            {scorecards.data?.scorecards.map((card, index) => (
              <article className="resource-card" key={card.id}>
                <div className="card-heading">
                  <h2>{when(card.at)}</h2>
                  {index === 0 && <span className="badge">Latest</span>}
                  {card.changed && <span className="badge bad">Changed</span>}
                </div>
                <p className="field-hint">
                  {card.browserVersion} · {card.trigger}
                </p>
                <table className="library-table">
                  <tbody>
                    {card.modes.map((mode: any) => (
                      <tr key={mode.mode}>
                        <td>
                          {mode.mode}
                          {card.recommended === mode.mode && " ★"}
                        </td>
                        <td>{mode.status === "measured" ? mode.score : mode.status}</td>
                        <td>
                          {[
                            ...mode.errors,
                            ...mode.failedChecks,
                            ...mode.warnings,
                            ...mode.signals,
                          ].join(", ") ||
                            mode.reason ||
                            "Nothing found"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </article>
            ))}
          </div>
        </>
      )}
      {tab === "lab" && (
        <>
          <div className="filter-bar">
            <select
              className="input"
              aria-label="Comparison baseline"
              value={baseline}
              onChange={(e) => setBaseline(e.target.value)}
            >
              <option value="">No baseline comparison</option>
              {labs.data?.reports.map((report) => (
                <option key={report.id} value={report.id}>
                  {report.browserVersion} · {when(report.at)}
                </option>
              ))}
            </select>
            <button
              className="button"
              disabled={!session || action.busy}
              onClick={() =>
                void inspectAction("/v1/compatibility/runs", {
                  sessionId: session?.id,
                  ...(baseline ? { baselineId: baseline } : {}),
                }).catch(() => {})
              }
            >
              Run current browser fixtures
            </button>
          </div>
          <p className="field-hint">
            The lab opens owned test fixtures in the selected browser. Take control before running
            it.
          </p>
          <div className="resource-grid">
            {labs.data?.reports.map((report) => (
              <article className="resource-card" key={report.id}>
                <div className="card-heading">
                  <h2>{report.browserVersion}</h2>
                  <span className="badge">{report.passed ? "Passed" : "Check findings"}</span>
                </div>
                <p>
                  {report.mode} · {report.runtime} · {when(report.at)}
                </p>
                {report.checks?.map((check: any) => (
                  <div className="assertion-row" key={check.name}>
                    <span className="badge">{check.status}</span>
                    <span>{check.name}</span>
                    <small>{check.detail}</small>
                  </div>
                ))}
                {!!report.regressions?.length && (
                  <p className="page-error">Regressions: {report.regressions.join(", ")}</p>
                )}
              </article>
            ))}
          </div>
        </>
      )}
      {detail !== undefined && (
        <div className="work-result">
          <button className="pill-button" onClick={() => setDetail(undefined)}>
            Close report
          </button>
          <pre>{JSON.stringify(detail, null, 2)}</pre>
        </div>
      )}
      <dialog className="dialog wide-dialog" ref={editor}>
        <ActionForm
          key={`${tab}:${editing?.name}:${editing?.revision}`}
          title={`${editing ? "Edit" : "Create"} ${tab === "sites" ? "site" : "identity"} profile`}
          busy={action.busy}
          error={action.error}
          onSubmit={save}
        >
          <Field name="name" label="Profile name" value={editing?.name} required />
          {tab === "sites" ? (
            <>
              <Field
                name="origin"
                label="Exact site origin"
                type="url"
                value={editing?.origin}
                required
              />
              <Field
                name="identityProfile"
                label="Identity profile (optional)"
                value={editing?.identityProfile}
              />
              <Field
                name="permissions"
                label="Permissions (comma separated)"
                value={editing?.permissions?.join(", ")}
              />
              <Field
                name="extensions"
                label="Extensions (comma separated)"
                value={editing?.extensions?.join(", ")}
              />
              <JsonField
                name="interaction"
                label="Interaction preferences"
                value={editing?.interaction ?? { frictionDetection: true, actionDelayMs: 0 }}
              />
            </>
          ) : (
            <JsonField
              name="bindings"
              label="Saved browser and login bindings"
              value={editing?.bindings ?? { cookieSets: [] }}
            />
          )}
          <JsonField
            name="settings"
            label="Coherent browser settings"
            value={
              editing?.settings ?? {
                compatibilityMode: "compatible",
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                locale: navigator.language,
                dimensions: { width: 1440, height: 900 },
              }
            }
          />
          <button className="pill-button" type="button" onClick={() => editor.current?.close()}>
            Cancel
          </button>
        </ActionForm>
      </dialog>
    </Page>
  );
}
