import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  apiUrl,
  mutate,
  parkSession,
  resumeSession,
  sessionPath,
  updateSession,
  type Handoff,
  type Recording,
  type RecordingFrame,
  type SessionDetails,
  type TimelineEntry,
} from "../api";
import { useResource } from "../hooks";

export function deadline(session: SessionDetails) {
  if (session.status === "parked")
    return `Parked${session.parkReason ? ` · ${session.parkReason}` : ""}`;
  if (!session.expiresAt) return session.keepAlive ? "Kept alive" : "No automatic expiry";
  const seconds = Math.max(0, Math.ceil((Date.parse(session.expiresAt) - Date.now()) / 1000));
  return `${session.onExpire === "release" ? "Releases" : "Parks"} in ${
    seconds >= 60 ? `${Math.ceil(seconds / 60)} min` : `${seconds} sec`
  }`;
}

export function SessionActions({
  session,
  onChange,
}: {
  session: SessionDetails;
  onChange: (s?: SessionDetails) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const perform = async () => {
    setBusy(true);
    setError(null);
    controller.current = new AbortController();
    try {
      onChange(
        await (session.status === "parked"
          ? resumeSession(session.id, controller.current.signal)
          : parkSession(session.id)),
      );
    } catch (e) {
      if (!controller.current.signal.aborted) setError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const result = await updateSession(session.id, {
        name: String(f.get("name") || ""),
        timeout: Number(f.get("timeout") || 0) * 60000,
        idleTimeout: Number(f.get("idleTimeout") || 0) * 60000,
        onExpire: f.get("onExpire"),
        keepAlive: f.get("keepAlive") === "on",
      });
      dialog.current?.close();
      onChange(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!["live", "parked"].includes(session.status)) return null;
  return (
    <>
      <button
        className="pill-button"
        disabled={busy || Boolean(session.isSelenium && session.status === "live")}
        onClick={() => void perform()}
      >
        {busy
          ? session.status === "parked"
            ? "Waiting for a slot…"
            : "Parking…"
          : session.status === "parked"
          ? "Resume"
          : "Park"}
      </button>
      <button className="pill-button" onClick={() => dialog.current?.showModal()}>
        Settings
      </button>
      {error && (
        <span role="alert" className="inline-error">
          {error}
        </span>
      )}
      <dialog className="dialog" ref={dialog}>
        <form className="dialog-form" onSubmit={submit}>
          <div className="dialog-head">
            <h2 className="dialog-title">Session settings</h2>
            <p className="dialog-description">
              Zero disables a time limit. Keep alive exempts idle expiry only.
            </p>
          </div>
          <div className="dialog-body">
            <label className="field">
              Name
              <input className="input" name="name" maxLength={80} defaultValue={session.name} />
            </label>
            <div className="form-grid">
              <label className="field">
                Idle limit (minutes)
                <input
                  className="input"
                  type="number"
                  name="idleTimeout"
                  min={0}
                  step="any"
                  defaultValue={(session.idleTimeout ?? 0) / 60000}
                />
              </label>
              <label className="field">
                Lifetime (minutes)
                <input
                  className="input"
                  type="number"
                  name="timeout"
                  min={0}
                  step="any"
                  defaultValue={session.timeout / 60000}
                />
              </label>
            </div>
            <label className="field">
              On expiry
              <select className="input" name="onExpire" defaultValue={session.onExpire ?? "park"}>
                <option value="park">Park and keep state</option>
                <option value="release">Release and discard state</option>
              </select>
            </label>
            <label className="check-row">
              <input type="checkbox" name="keepAlive" defaultChecked={session.keepAlive} />
              Keep alive when idle
            </label>
            {error && (
              <p className="dialog-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="dialog-foot">
            <button className="button" type="button" onClick={() => dialog.current?.close()}>
              Cancel
            </button>
            <button className="button" data-variant="primary" disabled={busy}>
              Save settings
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}

export function HandoffBanner({ session }: { session: SessionDetails }) {
  const { data, refresh } = useResource<Handoff>(
    session.status === "live" ? `${sessionPath(session.id)}/handoff` : null,
    3000,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  if (data?.status !== "waiting") return null;
  const act = async (action: string) => {
    setBusy(true);
    try {
      await mutate(`${sessionPath(session.id)}/handoff/${action}`, {});
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="handoff-banner" role="status">
      <div>
        <span className="eyebrow">Needs your help</span>
        <h2>{data.reason}</h2>
        {data.instructions && <p>{data.instructions}</p>}
        <small>Continue in the live browser, then mark this request done.</small>
        {error && <p role="alert">{error}</p>}
      </div>
      <div className="button-row">
        <button className="button" disabled={busy} onClick={() => void act("cancel")}>
          Cancel request
        </button>
        <button
          className="button"
          data-variant="primary"
          disabled={busy}
          onClick={() => void act("done")}
        >
          Done, continue
        </button>
      </div>
    </section>
  );
}

export function SessionHistory({ session }: { session: SessionDetails }) {
  const [tab, setTab] = useState("activity");
  return (
    <section className="session-history">
      <div className="history-tabs" role="tablist">
        {["activity", "downloads", "replay"].map((item) => (
          <button key={item} role="tab" aria-selected={tab === item} onClick={() => setTab(item)}>
            {item.charAt(0).toUpperCase() + item.slice(1)}
          </button>
        ))}
      </div>
      <div className="history-content">
        {tab === "activity" ? (
          <Timeline session={session} />
        ) : tab === "downloads" ? (
          <Downloads session={session} />
        ) : (
          <Replay session={session} />
        )}
      </div>
    </section>
  );
}

function Timeline({ session }: { session: SessionDetails }) {
  const { data, error } = useResource<{ entries: TimelineEntry[] }>(
    `${sessionPath(session.id)}/timeline?limit=100`,
  );
  if (error)
    return (
      <p className="empty-state" role="alert">
        {error}
      </p>
    );
  if (!data?.entries.length)
    return (
      <p className="empty-state">
        {data ? "Activity will appear here as the browser is used." : "Loading activity…"}
      </p>
    );
  return (
    <ol className="activity-list">
      {[...data.entries].reverse().map((entry) => (
        <li key={entry.seq}>
          <time>{new Date(entry.at).toLocaleTimeString()}</time>
          <div>
            <strong>{entry.tool || entry.kind}</strong>
            {entry.status && (
              <span className={`badge ${entry.status === "error" ? "bad" : ""}`}>
                {entry.status}
              </span>
            )}
            <p>{entry.error || entry.title || entry.url || entry.client}</p>
            {entry.args != null && (
              <details>
                <summary>Details</summary>
                <pre>{JSON.stringify(entry.args, null, 2)}</pre>
              </details>
            )}
            {entry.screenshot && (
              <a
                href={apiUrl(`${sessionPath(session.id)}/timeline/${entry.seq}/screenshot`)}
                target="_blank"
                rel="noreferrer"
              >
                <img
                  className="activity-shot"
                  src={apiUrl(`${sessionPath(session.id)}/timeline/${entry.seq}/screenshot`)}
                  loading="lazy"
                  alt={`Screenshot at ${new Date(entry.at).toLocaleTimeString()}`}
                />
              </a>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

type SessionFile = {
  name?: string;
  path?: string;
  size?: number;
  createdAt?: string;
  downloadUrl?: string;
  url?: string;
};
export const bytes = (value = 0) =>
  value >= 1e9
    ? `${(value / 1e9).toFixed(1)} GB`
    : value >= 1e6
    ? `${(value / 1e6).toFixed(1)} MB`
    : value >= 1e3
    ? `${(value / 1e3).toFixed(1)} KB`
    : `${value} B`;
function Downloads({ session }: { session: SessionDetails }) {
  const { data, error } = useResource<
    { files?: SessionFile[]; data?: SessionFile[] } | SessionFile[]
  >(`${sessionPath(session.id)}/files`);
  const files = Array.isArray(data) ? data : data?.files ?? data?.data ?? [];
  if (error)
    return (
      <p className="empty-state" role="alert">
        {error}
      </p>
    );
  return files.length ? (
    <ul className="file-list">
      {files.map((file, i) => {
        const path = file.path || file.name || String(i);
        return (
          <li key={path}>
            <span>
              {file.name || path}
              <small>{bytes(file.size)}</small>
            </span>
            <a
              className="pill-button"
              href={apiUrl(
                `${sessionPath(session.id)}/files/${path
                  .split("/")
                  .map(encodeURIComponent)
                  .join("/")}`,
              )}
              download
            >
              Download
            </a>
          </li>
        );
      })}
    </ul>
  ) : (
    <p className="empty-state">{data ? "No downloads in this session." : "Loading downloads…"}</p>
  );
}

function Replay({ session }: { session: SessionDetails }) {
  const path = sessionPath(session.id);
  const { data: recording, refresh } = useResource<Recording>(`${path}/recording`);
  const { data, refresh: refreshFrames } = useResource<{ frames: RecordingFrame[] }>(
    `${path}/recording/frames?limit=1000`,
  );
  const [index, setIndex] = useState(0),
    [playing, setPlaying] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const frames = data?.frames ?? [],
    frame = frames[Math.min(index, Math.max(0, frames.length - 1))];
  useEffect(() => {
    if (!playing || !frames.length) return;
    const timer = window.setTimeout(
      () => {
        if (index >= frames.length - 1) {
          setPlaying(false);
          return;
        }
        setIndex((n) => n + 1);
      },
      Math.max(100, Math.min(2000, (frames[index + 1]?.t ?? 0) - (frames[index]?.t ?? 0))),
    );
    return () => window.clearTimeout(timer);
  }, [playing, index, frames]);
  const action = async (kind: string) => {
    setBusy(true);
    setError("");
    try {
      await mutate(
        `${path}/recording${kind === "delete" ? "" : `/${kind}`}`,
        {},
        kind === "delete" ? "DELETE" : "POST",
      );
      refresh();
      refreshFrames();
      setIndex(0);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="replay">
      <div className="button-row">
        <span>
          {recording
            ? `${recording.frames} frames · ${bytes(recording.bytes)}`
            : "Recording is off"}
        </span>
        {session.status === "live" && (
          <button
            className="pill-button"
            disabled={busy}
            onClick={() => void action(recording?.status === "recording" ? "stop" : "start")}
          >
            {recording?.status === "recording" ? "Stop recording" : "Start recording"}
          </button>
        )}
        {recording && (
          <button
            className="pill-button"
            disabled={busy}
            onClick={() => {
              if (window.confirm("Delete this recording?")) void action("delete");
            }}
          >
            Delete recording
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {frame ? (
        <>
          <img
            className="replay-frame"
            src={apiUrl(`${path}/recording/frames/${frame.seq}`)}
            alt={`Recorded browser at ${new Date(frame.at).toLocaleString()}`}
          />
          <div className="replay-controls">
            <button
              className="pill-button"
              onClick={() => {
                if (index === frames.length - 1) setIndex(0);
                setPlaying(!playing);
              }}
            >
              {playing ? "Pause" : "Play"}
            </button>
            <input
              aria-label="Replay position"
              type="range"
              min={0}
              max={Math.max(0, frames.length - 1)}
              value={Math.min(index, frames.length - 1)}
              onChange={(e) => {
                setPlaying(false);
                setIndex(Number(e.target.value));
              }}
            />
            <time>{new Date(frame.at).toLocaleTimeString()}</time>
          </div>
          <p className="field-hint">{frame.url}</p>
        </>
      ) : (
        <p className="empty-state">Record a live browser to replay its activity here.</p>
      )}
    </div>
  );
}
