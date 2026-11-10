import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  captureCookieSet,
  deleteCookieSet,
  listCookieSets,
  mutate,
  type CookieSetSummary,
  type SessionDetails,
} from "../api";
import { Notice } from "./notice";
import { ErrorMessage } from "./workspace-pages";

export function useCookieSets() {
  const [state, setState] = useState<{
    sets: CookieSetSummary[] | undefined;
    encrypted: boolean;
    error: string | null;
  }>({ sets: undefined, encrypted: false, error: null });
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    listCookieSets(controller.signal)
      .then(({ sets, encrypted }) => setState({ sets, encrypted, error: null }))
      .catch((error) => {
        if (controller.signal.aborted) return;
        setState((s) => ({ ...s, error: error instanceof Error ? error.message : String(error) }));
      });
    return () => controller.abort();
  }, [version]);

  return { ...state, refresh };
}

function when(iso: string | null) {
  if (!iso) return "never";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function CookieLibraryPage() {
  const { sets, encrypted, error, refresh } = useCookieSets();
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState("");
  const [selected, setSelected] = useState<CookieSetSummary | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const action = async (set: CookieSetSummary, kind: string) => {
    setBusy(set.name);
    setFailure("");
    try {
      await mutate(`/v1/cookie-library/${encodeURIComponent(set.name)}/${kind}`, {});
      refresh();
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!selected) return;
    const f = new FormData(e.currentTarget);
    const val = (k: string) => String(f.get(k) || "").trim() || undefined;
    setBusy(selected.name);
    setFailure("");
    try {
      await mutate(
        `/v1/cookie-library/${encodeURIComponent(selected.name)}`,
        {
          description: val("description"),
          writeBack: f.get("writeBack") === "on",
          pinFingerprint: f.get("pinFingerprint") === "on",
          egress: val("egress"),
          acl: {
            clients:
              f.get("access") === "all"
                ? ["*"]
                : f.get("access") === "ui"
                ? []
                : String(f.get("clients") || "")
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
          },
          authCookies: String(f.get("authCookies") || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          check: val("url")
            ? {
                url: val("url"),
                loggedInSelector: val("loggedInSelector"),
                loggedOutSelector: val("loggedOutSelector"),
                loggedOutUrlPattern: val("loggedOutUrlPattern"),
                textIncludes: val("textIncludes"),
                intervalHours: Number(f.get("intervalHours")),
                enabled: f.get("enabled") === "on",
              }
            : undefined,
        },
        "PATCH",
      );
      dialog.current?.close();
      refresh();
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (error) return <Notice title="Can't load the cookie library">{error}</Notice>;
  if (!sets) return <Notice title="Loading" busy />;

  return (
    <section className="library" aria-label="Cookie library">
      <div className="library-head">
        <h1 className="library-title">Saved logins</h1>
        <p className="field-hint">
          Reuse your sign-ins across browsers and keep them healthy with regular checks.{" "}
          {encrypted ? "Encrypted at rest." : "Not encrypted at rest."}
        </p>
      </div>
      <ErrorMessage error={failure} />
      {sets.length === 0 ? (
        <Notice title="No saved cookies yet">
          Log in to a site in a session, then use <strong>Save cookies</strong> above the live view.
        </Notice>
      ) : (
        <table className="library-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Sites</th>
              <th>Cookies</th>
              <th>Health</th>
              <th>Auth expiry</th>
              <th>Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sets.map((set) => (
              <tr key={set.name}>
                <td>
                  <code>{set.name}</code>
                  {set.description && <div className="field-hint">{set.description}</div>}
                </td>
                <td className="library-domains">{set.domains.join(", ") || "none"}</td>
                <td>
                  {set.cookieCount}
                  {set.originCount > 0 && ` + ${set.originCount} storage`}
                </td>
                <td>
                  <span
                    className={`badge ${
                      ["failing", "expired"].includes(set.health?.status || "") ? "bad" : ""
                    }`}
                  >
                    {set.health?.status ?? "unknown"}
                  </span>
                  {set.health?.lastResult && (
                    <small title={set.health.lastResult.reason}>
                      {set.health.lastResult.reason}
                    </small>
                  )}
                </td>
                <td>{when(set.authExpiresAt ?? set.expiresAt)}</td>
                <td>{when(set.updatedAt)}</td>
                <td>
                  <div className="button-row">
                    <button
                      className="pill-button"
                      disabled={busy === set.name || !set.check}
                      onClick={() => void action(set, "check")}
                    >
                      Check
                    </button>
                    <button
                      className="pill-button"
                      onClick={() => {
                        setSelected(set);
                        dialog.current?.showModal();
                      }}
                    >
                      Settings
                    </button>
                    {set.hasPrevious && (
                      <button
                        className="pill-button"
                        disabled={busy === set.name}
                        onClick={() => {
                          if (window.confirm(`Restore the previous login for ${set.name}?`))
                            void action(set, "restore-previous");
                        }}
                      >
                        Restore
                      </button>
                    )}
                    <button
                      type="button"
                      className="pill-button"
                      data-variant="danger"
                      disabled={busy === set.name}
                      onClick={async () => {
                        if (!window.confirm(`Delete the cookie set "${set.name}"?`)) return;
                        setBusy(set.name);
                        try {
                          await deleteCookieSet(set.name);
                        } catch (e) {
                          setFailure((e as Error).message);
                        } finally {
                          setBusy(null);
                          refresh();
                        }
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <dialog className="dialog wide-dialog" ref={dialog}>
        <form key={selected?.name} className="dialog-form" onSubmit={save}>
          <div className="dialog-head">
            <h2 className="dialog-title">{selected?.name} settings</h2>
            <p className="dialog-description">
              Check sign-in status and keep this login's device and network consistent.
            </p>
          </div>
          <div className="dialog-body">
            <label className="field">
              Description
              <input className="input" name="description" defaultValue={selected?.description} />
            </label>
            <label className="field">
              Check URL
              <input
                className="input"
                name="url"
                type="url"
                defaultValue={selected?.check?.url}
                placeholder="https://example.com/account"
              />
            </label>
            <div className="form-grid">
              <label className="field">
                Logged-in selector
                <input
                  className="input"
                  name="loggedInSelector"
                  defaultValue={selected?.check?.loggedInSelector}
                />
              </label>
              <label className="field">
                Logged-out selector
                <input
                  className="input"
                  name="loggedOutSelector"
                  defaultValue={selected?.check?.loggedOutSelector}
                />
              </label>
            </div>
            <label className="field">
              Logged-out URL pattern
              <input
                className="input"
                name="loggedOutUrlPattern"
                defaultValue={selected?.check?.loggedOutUrlPattern}
              />
            </label>
            <label className="field">
              Expected text
              <input
                className="input"
                name="textIncludes"
                defaultValue={selected?.check?.textIncludes}
              />
            </label>
            <label className="field">
              Check every (hours)
              <input
                className="input"
                name="intervalHours"
                type="number"
                min={1}
                defaultValue={selected?.check?.intervalHours ?? 24}
              />
            </label>
            <label className="check-row">
              <input
                name="enabled"
                type="checkbox"
                defaultChecked={selected?.check?.enabled ?? true}
              />
              Run checks automatically
            </label>
            <label className="check-row">
              <input
                name="writeBack"
                type="checkbox"
                defaultChecked={selected?.writeBack ?? true}
              />
              Save fresher cookies when a browser ends
            </label>
            <label className="check-row">
              <input
                name="pinFingerprint"
                type="checkbox"
                defaultChecked={selected?.pinFingerprint ?? true}
              />
              Reuse this login's browser fingerprint
            </label>
            <label className="field">
              Pinned network
              <input
                className="input"
                name="egress"
                defaultValue={selected?.egress}
                placeholder="Default"
              />
            </label>
            <label className="field">
              Access
              <select
                className="input"
                name="access"
                defaultValue={
                  !selected?.acl || selected.acl.clients.includes("*")
                    ? "all"
                    : selected.acl.clients.length
                    ? "restricted"
                    : "ui"
                }
              >
                <option value="all">All clients</option>
                <option value="restricted">Named clients only</option>
                <option value="ui">UI only</option>
              </select>
            </label>
            <label className="field">
              Allowed clients (comma separated)
              <input
                className="input"
                name="clients"
                defaultValue={selected?.acl?.clients.join(", ")}
                placeholder="mcp:owner@example.com"
              />
            </label>
            <label className="field">
              Authentication cookie names (comma separated)
              <input
                className="input"
                name="authCookies"
                defaultValue={selected?.authCookies?.join(", ")}
                placeholder="Automatic detection"
              />
            </label>
            <ErrorMessage error={failure} />
          </div>
          <div className="dialog-foot">
            <button type="button" className="button" onClick={() => dialog.current?.close()}>
              Cancel
            </button>
            <button className="button" data-variant="primary" disabled={Boolean(busy)}>
              Save settings
            </button>
          </div>
        </form>
      </dialog>
    </section>
  );
}

export function SaveCookiesButton({ session }: { session: SessionDetails }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<CookieSetSummary | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    const domains = String(data.get("domains") ?? "")
      .split(/[\s,]+/)
      .map((d) => d.trim())
      .filter(Boolean);
    const description = String(data.get("description") ?? "").trim() || undefined;
    setPending(true);
    setError(null);
    try {
      setSaved(
        await captureCookieSet(name, {
          sessionId: session.id,
          domains: domains.length ? domains : undefined,
          description,
        }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="pill-button"
        aria-haspopup="dialog"
        onClick={() => {
          setSaved(null);
          dialog.current?.showModal();
        }}
      >
        Save cookies
      </button>
      <dialog
        ref={dialog}
        className="dialog"
        aria-labelledby="save-cookies-title"
        onClose={() => setError(null)}
      >
        <form className="dialog-form" onSubmit={(event) => void submit(event)}>
          <div className="dialog-head">
            <h2 id="save-cookies-title" className="dialog-title">
              Save this session's cookies
            </h2>
            <p className="dialog-description">
              Stores the cookies and localStorage of this session in the cookie library, so new
              sessions can start logged in. A set with the same name is replaced.
            </p>
          </div>
          <div className="dialog-body">
            <label className="field">
              <span>Name</span>
              <input
                className="input"
                name="name"
                required
                pattern="[A-Za-z0-9][A-Za-z0-9._\-]{0,63}"
                placeholder="github-perso"
                autoComplete="off"
                spellCheck={false}
              />
              <p className="field-hint">Letters, digits, dot, dash or underscore.</p>
            </label>
            <label className="field">
              <span>Only these sites</span>
              <input
                className="input"
                name="domains"
                placeholder="github.com, google.com"
                autoComplete="off"
                spellCheck={false}
              />
              <p className="field-hint">Leave empty to keep every site. Subdomains are included.</p>
            </label>
            <label className="field">
              <span>Note</span>
              <input className="input" name="description" placeholder="Optional" />
            </label>
            {error && (
              <p className="dialog-error" role="alert">
                {error}
              </p>
            )}
            {saved && (
              <p className="field-hint" role="status">
                Saved <code>{saved.name}</code>: {saved.cookieCount} cookies for{" "}
                {saved.domains.length} site(s).
              </p>
            )}
          </div>
          <div className="dialog-foot">
            <button type="button" className="button" onClick={() => dialog.current?.close()}>
              {saved ? "Done" : "Cancel"}
            </button>
            <button type="submit" className="button" data-variant="primary" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}

/** Checkbox list for the new-session dialog; checked names are posted as cookieSets. */
export function CookieSetPicker() {
  const { sets } = useCookieSets();
  if (!sets || sets.length === 0) return null;
  return (
    <fieldset className="field cookie-picker">
      <legend>Start logged in with</legend>
      {sets.map((set) => (
        <label key={set.name} className="cookie-option">
          <input type="checkbox" name="cookieSets" value={set.name} />
          <code>{set.name}</code>
          <span className="field-hint">{set.domains.slice(0, 3).join(", ")}</span>
        </label>
      ))}
    </fieldset>
  );
}
