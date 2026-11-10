import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { apiUrl, mutate, request, type EgressProfile, type PoolStatus } from "../api";
import { useResource } from "../hooks";
import { bytes } from "./session-tools";

export type WorkspaceView =
  | "sessions"
  | "cookies"
  | "pool"
  | "watchers"
  | "warm"
  | "extensions"
  | "network"
  | "extract"
  | "operations";
export const viewNames: Record<WorkspaceView, string> = {
  sessions: "Sessions",
  cookies: "Saved logins",
  pool: "Browser pool",
  watchers: "Page watchers",
  warm: "Warm browsers",
  extensions: "Extensions",
  network: "Network",
  extract: "Extract",
  operations: "Activity & notifications",
};
export function Page({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="workspace-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Steel workspace</p>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
export function ErrorMessage({ error }: { error?: string | null }) {
  return error ? (
    <p role="alert" className="page-error">
      {error}
    </p>
  ) : null;
}
const csv = (value: FormDataEntryValue | null) =>
  String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const text = (f: FormData, key: string) => String(f.get(key) || "").trim() || undefined;
const when = (date?: string) => (date ? new Date(date).toLocaleString() : "Never");

export function PoolSummary() {
  const { data } = useResource<PoolStatus>("/v1/pool", 3000);
  if (!data) return null;
  return (
    <div className="pool-summary">
      <span>
        <b>{data.live}</b> / {data.maxSessions} browsers
      </span>
      <span>
        <b>{data.free}</b> free
      </span>
      <span>
        <b>{data.parked ?? 0}</b> parked
      </span>
      <span>
        <b>{data.queued}</b> waiting
      </span>
      {data.memory && (
        <span data-pressure={data.memory.pressure}>
          {bytes(data.memory.availableBytes)} available
        </span>
      )}
      <a href="?view=pool">Pool details ↗</a>
    </div>
  );
}

export function PoolPage() {
  const { data, error } = useResource<PoolStatus>("/v1/pool", 2000);
  return (
    <Page
      title="Browser pool"
      description="Capacity, queued requests, and the memory available to your browsers."
    >
      <ErrorMessage error={error} />
      {data && (
        <>
          <div className="stat-grid">
            <Stat
              label="Live browsers"
              value={`${data.live} / ${data.maxSessions}`}
              note={`${data.free} slots available`}
            />
            <Stat label="Waiting" value={String(data.queued)} note="Requests served in order" />
            <Stat label="Parked" value={String(data.parked ?? 0)} note="State saved for later" />
            <Stat
              label="Memory available"
              value={bytes(data.memory?.availableBytes)}
              note={data.memory?.pressure ? "Memory guard is active" : "Capacity is available"}
            />
          </div>
          <div className="table-wrap">
            <table className="library-table">
              <thead>
                <tr>
                  <th>Slot</th>
                  <th>Status</th>
                  <th>Session</th>
                  <th>Memory</th>
                  <th>Tabs</th>
                </tr>
              </thead>
              <tbody>
                {data.slots.map((slot) => (
                  <tr key={slot.index}>
                    <td>
                      {slot.index + 1}
                      {slot.primary && <small> Primary</small>}
                    </td>
                    <td>
                      <span className="badge">{slot.state}</span>
                    </td>
                    <td>
                      {slot.sessionId ? (
                        <a href={`?session=${slot.sessionId}`}>
                          {slot.sessionName || slot.sessionId.slice(0, 8)}
                        </a>
                      ) : (
                        "Available"
                      )}
                    </td>
                    <td>{slot.rssBytes == null ? "Unavailable" : bytes(slot.rssBytes)}</td>
                    <td>{slot.pages ?? "Unavailable"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h2 className="section-title">Waiting for a browser</h2>
          {data.queue.length ? (
            <ol className="queue-list">
              {data.queue.map((q, i) => (
                <li key={q.sessionId || i}>
                  <strong>#{q.position}</strong>
                  <span>
                    {q.client || q.sessionId || "Browser request"}
                    <small>{q.kind || "Session"}</small>
                  </span>
                  <span>{Math.round(q.waitingMs / 1000)} sec</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="empty-state">No requests are waiting.</p>
          )}
          {data.background && (
            <p className="field-hint">
              Background jobs: {data.background.running} / {data.background.max}
            </p>
          )}
        </>
      )}
    </Page>
  );
}
function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </div>
  );
}

type Warm = {
  name: string;
  sessionId: string;
  status: string;
  enabled: boolean;
  browserProfile?: string;
  cookieSets?: string[];
  egress?: string;
  startUrl?: string;
  extensions?: string[];
  refreshMinutes?: number;
  lastError?: string;
  lastStartedAt?: string;
};
export function WarmPage() {
  const { data, error, refresh } = useResource<{ warm: Warm[] }>("/v1/warm");
  const [selected, setSelected] = useState<Warm | null>(null),
    [busy, setBusy] = useState(false),
    [failure, setFailure] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const action = async (path: string, body?: unknown, method = "POST") => {
    setBusy(true);
    setFailure("");
    try {
      await mutate(path, body, method);
      refresh();
      return true;
    } catch (e) {
      setFailure((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (
      await action(
        `/v1/warm/${encodeURIComponent(String(f.get("name")))}`,
        {
          browserProfile: text(f, "profile"),
          startUrl: text(f, "url"),
          egress: text(f, "egress"),
          cookieSets: csv(f.get("cookies")),
          extensions: csv(f.get("extensions")),
          enabled: f.get("enabled") === "on",
          refreshMinutes: text(f, "refresh") ? Number(f.get("refresh")) : undefined,
        },
        "PUT",
      )
    )
      dialog.current?.close();
  };
  return (
    <Page
      title="Warm browsers"
      description="Keep frequently used browsers ready for agents. One slot remains available for other work."
      action={
        <button
          className="button"
          data-variant="primary"
          onClick={() => {
            setSelected(null);
            dialog.current?.showModal();
          }}
        >
          Add warm browser
        </button>
      }
    >
      <ErrorMessage error={failure || error} />
      <div className="resource-grid">
        {data?.warm.map((item) => (
          <article className="resource-card" key={item.name}>
            <div className="card-heading">
              <h2>{item.name}</h2>
              <span className="badge">{item.status}</span>
            </div>
            <p>{item.startUrl || item.browserProfile || "Ready for browsing"}</p>
            <small>
              {item.egress || "Default network"} · Started {when(item.lastStartedAt)}
            </small>
            {item.lastError && <ErrorMessage error={item.lastError} />}
            <div className="button-row">
              <a className="pill-button" href={`?session=${item.sessionId}`}>
                Open
              </a>
              <button
                className="pill-button"
                disabled={busy}
                onClick={() => {
                  setSelected(item);
                  dialog.current?.showModal();
                }}
              >
                Edit
              </button>
              <button
                className="pill-button"
                disabled={busy}
                onClick={() => void action(`/v1/warm/${encodeURIComponent(item.name)}/restart`, {})}
              >
                Restart
              </button>
              <button
                className="pill-button"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(`Remove warm browser ${item.name}?`))
                    void action(`/v1/warm/${encodeURIComponent(item.name)}`, undefined, "DELETE");
                }}
              >
                Remove
              </button>
            </div>
          </article>
        ))}
      </div>
      {data?.warm.length === 0 && <p className="empty-state">No warm browsers yet.</p>}
      <dialog className="dialog" ref={dialog}>
        <form key={selected?.name || "new"} className="dialog-form" onSubmit={submit}>
          <div className="dialog-head">
            <h2 className="dialog-title">{selected ? "Edit" : "Add"} warm browser</h2>
          </div>
          <div className="dialog-body">
            <Field
              label="Name"
              name="name"
              required
              pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}"
              defaultValue={selected?.name}
              readOnly={Boolean(selected)}
            />
            <Field label="Start URL" name="url" type="url" defaultValue={selected?.startUrl} />
            <Field label="Saved browser" name="profile" defaultValue={selected?.browserProfile} />
            <Field
              label="Saved logins (comma separated)"
              name="cookies"
              defaultValue={selected?.cookieSets?.join(", ")}
            />
            <Field
              label="Network"
              name="egress"
              defaultValue={selected?.egress}
              placeholder="Default"
            />
            <Field
              label="Extensions (comma separated)"
              name="extensions"
              defaultValue={selected?.extensions?.join(", ")}
            />
            <Field
              label="Restart every (minutes, optional)"
              name="refresh"
              type="number"
              min={1}
              defaultValue={selected?.refreshMinutes}
            />
            <label className="check-row">
              <input name="enabled" type="checkbox" defaultChecked={selected?.enabled ?? true} />
              Enabled
            </label>
            <ErrorMessage error={failure} />
          </div>
          <DialogFoot dialog={dialog} busy={busy} />
        </form>
      </dialog>
    </Page>
  );
}

type Watcher = {
  id: string;
  name: string;
  url: string;
  intervalMinutes: number;
  enabled: boolean;
  cookieSets?: string[];
  egress?: string;
  waitFor?: number | string;
  activeHours?: { start: number; end: number; timezone: string };
  extract: {
    selector?: string;
    attribute?: string;
    regex?: string;
    fullText?: boolean;
    llm?: { schema: Record<string, unknown>; prompt?: string };
  };
  condition: { type: string; value?: unknown };
  notify: { cooldownMinutes: number; onErrorAfter: number };
  state: {
    lastRunAt?: string;
    nextRunAt: string;
    consecutiveErrors: number;
    lastValue?: unknown;
    running?: boolean;
  };
};
export function WatchersPage() {
  const { data, error, refresh } = useResource<{ watchers: Watcher[] }>("/v1/watchers");
  const [selected, setSelected] = useState<Watcher | null>(null),
    [history, setHistory] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [failure, setFailure] = useState("");
  const [notice, setNotice] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const action = async (path: string, body?: unknown, method = "POST") => {
    setBusy(true);
    setFailure("");
    setNotice("");
    try {
      const result = await mutate<{ status?: string; error?: string; matched?: boolean }>(
        path,
        body,
        method,
      );
      if (path.endsWith("/run"))
        setNotice(
          result.status === "postponed"
            ? "Check postponed while other browser work is running. It will retry on schedule."
            : result.status === "error"
            ? `Check failed: ${result.error || "Unknown error"}`
            : result.matched
            ? "Check complete. The notification condition matched."
            : "Check complete. No notification condition matched.",
        );
      refresh();
      return true;
    } catch (e) {
      setFailure((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      const condition = String(f.get("condition"));
      const schema = text(f, "schema");
      const wait = text(f, "waitFor");
      const value = text(f, "value");
      const body = {
        name: text(f, "name"),
        url: text(f, "url"),
        intervalMinutes: Number(f.get("interval")),
        enabled: f.get("enabled") === "on",
        cookieSets: csv(f.get("cookies")),
        egress: text(f, "egress"),
        waitFor: wait && /^\d+$/.test(wait) ? Number(wait) : wait,
        activeHours: text(f, "hoursStart")
          ? {
              start: Number(f.get("hoursStart")),
              end: Number(f.get("hoursEnd")),
              timezone: text(f, "timezone") || "UTC",
            }
          : undefined,
        extract: {
          selector: text(f, "selector"),
          attribute: text(f, "attribute"),
          regex: text(f, "regex"),
          fullText: f.get("fullText") === "on",
          ...(schema ? { llm: { schema: JSON.parse(schema), prompt: text(f, "prompt") } } : {}),
        },
        condition: {
          type: condition,
          value: condition === "lt" || condition === "gt" ? Number(value) : value,
        },
        notify: {
          cooldownMinutes: Number(f.get("cooldown")),
          onErrorAfter: Number(f.get("errors")),
        },
      };
      if (
        await action(
          selected ? `/v1/watchers/${selected.id}` : "/v1/watchers",
          body,
          selected ? "PATCH" : "POST",
        )
      )
        dialog.current?.close();
    } catch (e) {
      setFailure((e as Error).message);
    }
  };
  return (
    <Page
      title="Page watchers"
      description="Watch pages for meaningful changes and receive a notification when a condition is met."
      action={
        <button
          className="button"
          data-variant="primary"
          onClick={() => {
            setSelected(null);
            dialog.current?.showModal();
          }}
        >
          Watch a page
        </button>
      }
    >
      <ErrorMessage error={failure || error} />
      {notice && (
        <p role="status" className="field-hint">
          {notice}
        </p>
      )}
      <div className="resource-grid">
        {data?.watchers.map((w) => (
          <article className="resource-card" key={w.id}>
            <div className="card-heading">
              <h2>{w.name}</h2>
              <span className={`badge ${w.state.consecutiveErrors ? "bad" : ""}`}>
                {w.state.running ? "Checking" : w.enabled ? "Watching" : "Paused"}
              </span>
            </div>
            <p>{w.url}</p>
            <small>
              Every {w.intervalMinutes} min · Next {when(w.state.nextRunAt)}
            </small>
            <div className="button-row">
              <button
                className="pill-button"
                disabled={busy}
                onClick={() => void action(`/v1/watchers/${w.id}/run`, {})}
              >
                Check now
              </button>
              <button
                className="pill-button"
                onClick={() => {
                  setSelected(w);
                  dialog.current?.showModal();
                }}
              >
                Edit
              </button>
              <button
                className="pill-button"
                onClick={() => setHistory(history === w.id ? null : w.id)}
              >
                History
              </button>
              <button
                className="pill-button"
                disabled={busy}
                onClick={() =>
                  void action(`/v1/watchers/${w.id}`, { enabled: !w.enabled }, "PATCH")
                }
              >
                {w.enabled ? "Pause" : "Enable"}
              </button>
              <button
                className="pill-button"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(`Delete watcher ${w.name}?`))
                    void action(`/v1/watchers/${w.id}`, undefined, "DELETE");
                }}
              >
                Delete
              </button>
            </div>
            {history === w.id && <WatcherHistory id={w.id} />}
          </article>
        ))}
      </div>
      {data?.watchers.length === 0 && <p className="empty-state">No page watchers yet.</p>}
      <dialog className="dialog wide-dialog" ref={dialog}>
        <form key={selected?.id || "new"} className="dialog-form" onSubmit={submit}>
          <div className="dialog-head">
            <h2 className="dialog-title">{selected ? "Edit watcher" : "Watch a page"}</h2>
          </div>
          <div className="dialog-body">
            <Field label="Name" name="name" required maxLength={80} defaultValue={selected?.name} />
            <Field label="Page URL" name="url" type="url" required defaultValue={selected?.url} />
            <div className="form-grid">
              <Field
                label="Check every (minutes)"
                name="interval"
                type="number"
                min={5}
                required
                defaultValue={selected?.intervalMinutes ?? 60}
              />
              <Field
                label="CSS selector (optional)"
                name="selector"
                defaultValue={selected?.extract.selector}
                placeholder=".price"
              />
            </div>
            <div className="form-grid">
              <label className="field">
                Notify when
                <select
                  className="input"
                  name="condition"
                  defaultValue={selected?.condition.type ?? "changed"}
                >
                  {[
                    ["changed", "Value changes"],
                    ["contains", "Contains text"],
                    ["not_contains", "Does not contain"],
                    ["matches", "Matches pattern"],
                    ["lt", "Less than"],
                    ["gt", "Greater than"],
                    ["eq", "Equals"],
                  ].map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <Field
                label="Compared value"
                name="value"
                defaultValue={
                  selected?.condition.value == null ? "" : String(selected.condition.value)
                }
              />
            </div>
            <details>
              <summary>Login, network, and extraction options</summary>
              <Field
                label="Saved logins (comma separated)"
                name="cookies"
                defaultValue={selected?.cookieSets?.join(", ")}
              />
              <Field label="Network" name="egress" defaultValue={selected?.egress} />
              <Field
                label="Wait for selector or milliseconds"
                name="waitFor"
                defaultValue={selected?.waitFor}
              />
              <Field
                label="Element attribute"
                name="attribute"
                defaultValue={selected?.extract.attribute}
                placeholder="href"
              />
              <Field
                label="Extract matching pattern"
                name="regex"
                defaultValue={selected?.extract.regex}
              />
              <label className="check-row">
                <input
                  type="checkbox"
                  name="fullText"
                  defaultChecked={selected?.extract.fullText}
                />
                Read all page text
              </label>
              <Field
                label="Extraction instructions"
                name="prompt"
                defaultValue={selected?.extract.llm?.prompt}
              />
              <label className="field">
                Structured extraction schema (JSON, optional)
                <textarea
                  className="input"
                  name="schema"
                  rows={5}
                  defaultValue={
                    selected?.extract.llm
                      ? JSON.stringify(selected.extract.llm.schema, null, 2)
                      : ""
                  }
                />
              </label>
              <div className="form-grid">
                <Field
                  label="Active from hour (optional)"
                  name="hoursStart"
                  type="number"
                  min={0}
                  max={23}
                  defaultValue={selected?.activeHours?.start}
                />
                <Field
                  label="Active until hour"
                  name="hoursEnd"
                  type="number"
                  min={0}
                  max={23}
                  defaultValue={selected?.activeHours?.end}
                />
              </div>
              <Field
                label="Time zone"
                name="timezone"
                defaultValue={
                  selected?.activeHours?.timezone ||
                  Intl.DateTimeFormat().resolvedOptions().timeZone
                }
              />
            </details>
            <div className="form-grid">
              <Field
                label="Notification cooldown (minutes)"
                name="cooldown"
                type="number"
                min={0}
                defaultValue={selected?.notify.cooldownMinutes ?? 60}
              />
              <Field
                label="Notify after failed checks"
                name="errors"
                type="number"
                min={1}
                defaultValue={selected?.notify.onErrorAfter ?? 3}
              />
            </div>
            <label className="check-row">
              <input name="enabled" type="checkbox" defaultChecked={selected?.enabled ?? true} />
              Enabled
            </label>
            <ErrorMessage error={failure} />
          </div>
          <DialogFoot dialog={dialog} busy={busy} />
        </form>
      </dialog>
    </Page>
  );
}
function WatcherHistory({ id }: { id: string }) {
  const { data, error } = useResource<{
    history: { at: string; status: string; value?: unknown; matched?: boolean; error?: string }[];
  }>(`/v1/watchers/${id}/history`);
  return (
    <div className="watch-history">
      <ErrorMessage error={error} />
      {data?.history.map((entry, i) => (
        <div key={i}>
          <small>
            {when(entry.at)} · {entry.status}
            {entry.matched ? " · matched" : ""}
          </small>
          <pre>{entry.error || JSON.stringify(entry.value, null, 2)}</pre>
        </div>
      ))}
    </div>
  );
}

type Extension = {
  name: string;
  title: string;
  version: string;
  description?: string;
  source: "bundled" | "library";
};
export function ExtensionsPage() {
  const { data, error, refresh } = useResource<{ extensions: Extension[] }>("/v1/extensions", 0);
  const [busy, setBusy] = useState(false),
    [failure, setFailure] = useState("");
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setFailure("");
    const f = new FormData(e.currentTarget);
    try {
      const file = f.get("file") as File;
      if (file?.size) {
        const payload = new FormData();
        payload.set("name", String(f.get("name")));
        payload.set("file", file);
        await request("/v1/extensions", { method: "POST", body: payload });
      } else await mutate("/v1/extensions", { name: text(f, "name"), url: text(f, "url") });
      refresh();
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Page
      title="Extensions"
      description="Install an extension once, then choose it when starting a browser."
    >
      <ErrorMessage error={failure || error} />
      <form className="inline-form" onSubmit={submit}>
        <Field
          label="Library name"
          name="name"
          required
          pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}"
        />
        <Field label="ZIP or CRX URL" name="url" type="url" />
        <Field label="Or choose a ZIP / CRX" name="file" type="file" accept=".zip,.crx" />
        <button className="button" data-variant="primary" disabled={busy}>
          {busy ? "Installing…" : "Install extension"}
        </button>
      </form>
      <div className="resource-grid">
        {data?.extensions.map((ext) => (
          <article className="resource-card" key={ext.name}>
            <div className="card-heading">
              <h2>{ext.title}</h2>
              <span className="badge">{ext.source}</span>
            </div>
            <p>{ext.description}</p>
            <small>
              {ext.name} · v{ext.version}
            </small>
            {ext.source === "library" && (
              <div className="button-row">
                <button
                  className="pill-button"
                  disabled={busy}
                  onClick={async () => {
                    if (!window.confirm(`Remove ${ext.title}?`)) return;
                    try {
                      await mutate(
                        `/v1/extensions/${encodeURIComponent(ext.name)}`,
                        undefined,
                        "DELETE",
                      );
                      refresh();
                    } catch (e) {
                      setFailure((e as Error).message);
                    }
                  }}
                >
                  Remove
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
    </Page>
  );
}

export function NetworkPage() {
  const { data, error, refresh } = useResource<{ default: string; profiles: EgressProfile[] }>(
    "/v1/egress",
    60000,
  );
  return (
    <Page
      title="Network"
      description="Choose where your browsers connect from. Saved logins can pin a network for consistent sign-ins."
      action={
        <button className="button" onClick={refresh}>
          Refresh health
        </button>
      }
    >
      <ErrorMessage error={error} />
      <div className="resource-grid">
        {data?.profiles.map((p) => (
          <article className="resource-card" key={p.name}>
            <div className="card-heading">
              <h2>{p.label || p.name}</h2>
              <span className={`badge ${p.healthy === false ? "bad" : ""}`}>
                {p.healthy == null ? "Unchecked" : p.healthy ? "Healthy" : "Unavailable"}
              </span>
            </div>
            <p>
              {p.publicIp || "IP not available"}
              {p.country ? ` · ${p.country}` : ""}
            </p>
            <small>
              {p.type || "Proxy"}
              {data.default === p.name ? " · Default" : ""}
            </small>
            <p className="field-hint">
              {p.checkedAt
                ? `Checked ${when(p.checkedAt)}`
                : "Select this network when starting a browser."}
            </p>
          </article>
        ))}
      </div>
    </Page>
  );
}

export function ExtractPage() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [result, setResult] = useState<{
      data: unknown;
      url: string;
      title: string;
      model: string;
      markdown?: string;
    } | null>(null);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      setResult(
        await mutate("/v1/extract", {
          url: text(f, "url"),
          sessionId: text(f, "sessionId"),
          schema: JSON.parse(String(f.get("schema"))),
          prompt: text(f, "prompt"),
          cookieSets: csv(f.get("cookies")),
          egress: text(f, "egress"),
          includeMarkdown: f.get("markdown") === "on",
          queueTimeout: 45000,
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Page
      title="Structured extraction"
      description="Turn page content into structured data, with a schema you control."
    >
      <form className="resource-card extract-form" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Page URL" name="url" type="url" placeholder="https://example.com" />
          <Field label="Or live session ID" name="sessionId" />
        </div>
        <Field
          label="What to extract"
          name="prompt"
          placeholder="Find the product name and current price."
        />
        <label className="field">
          Output schema (JSON)
          <textarea
            className="input code-input"
            name="schema"
            rows={8}
            required
            defaultValue={
              '{\n  "type": "object",\n  "properties": {\n    "title": { "type": "string" }\n  },\n  "required": ["title"]\n}'
            }
          />
        </label>
        <div className="form-grid">
          <Field label="Saved logins (comma separated)" name="cookies" />
          <Field label="Network" name="egress" />
        </div>
        <label className="check-row">
          <input name="markdown" type="checkbox" />
          Include source text
        </label>
        <ErrorMessage error={error} />
        <button className="button" data-variant="primary" disabled={busy}>
          {busy ? "Extracting…" : "Extract data"}
        </button>
      </form>
      {result && (
        <section className="resource-card">
          <h2>{result.title}</h2>
          <small>
            {result.url} · {result.model}
          </small>
          <pre>{JSON.stringify(result.data, null, 2)}</pre>
          {result.markdown && (
            <details>
              <summary>Source text</summary>
              <pre>{result.markdown}</pre>
            </details>
          )}
        </section>
      )}
    </Page>
  );
}

export function OperationsPage() {
  const [tab, setTab] = useState("notifications");
  return (
    <Page
      title="Activity & notifications"
      description="Recent operational events, login checks, and notices from your browsers."
    >
      <div className="history-tabs" role="tablist">
        {["notifications", "audit"].map((item) => (
          <button key={item} role="tab" aria-selected={tab === item} onClick={() => setTab(item)}>
            {item === "audit" ? "Audit log" : "Notifications"}
          </button>
        ))}
        <a className="pill-button" href={apiUrl("/metrics")} target="_blank" rel="noreferrer">
          Metrics ↗
        </a>
      </div>
      <OperationList kind={tab} />
    </Page>
  );
}
function OperationList({ kind }: { kind: string }) {
  const { data, error } = useResource<Record<string, unknown[]> | unknown[]>(
    `/v1/${kind}?limit=100`,
  );
  const items = Array.isArray(data)
    ? data
    : data
    ? data[kind] || data.events || data.entries || data.data || []
    : [];
  return (
    <>
      <ErrorMessage error={error} />
      {items.length ? (
        <div className="operations-list">
          {items.map((v, i) => {
            const row = v as Record<string, unknown>;
            return (
              <article key={i}>
                <small>
                  {String(row.at || row.createdAt || "")}
                  {row.severity ? ` · ${row.severity}` : ""}
                </small>
                <h2>{String(row.title || row.event || "Event")}</h2>
                <p>{String(row.message || row.subject || row.client || "")}</p>
                {Boolean(row.sessionId) && (
                  <a href={`?session=${encodeURIComponent(String(row.sessionId))}`}>
                    Open session ↗
                  </a>
                )}
                {row.detail != null && (
                  <details>
                    <summary>Details</summary>
                    <pre>{JSON.stringify(row.detail, null, 2)}</pre>
                  </details>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        <p className="empty-state">{data ? "Nothing to show yet." : "Loading…"}</p>
      )}
    </>
  );
}

function Field({
  label,
  ...props
}: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="field">
      {label}
      <input className="input" {...props} />
    </label>
  );
}
function DialogFoot({
  dialog,
  busy,
}: {
  dialog: React.RefObject<HTMLDialogElement | null>;
  busy: boolean;
}) {
  return (
    <div className="dialog-foot">
      <button className="button" type="button" onClick={() => dialog.current?.close()}>
        Cancel
      </button>
      <button className="button" data-variant="primary" disabled={busy}>
        {busy ? "Saving…" : "Save"}
      </button>
    </div>
  );
}
