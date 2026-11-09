import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  captureCookieSet,
  deleteCookieSet,
  listCookieSets,
  type CookieSetSummary,
  type SessionDetails,
} from "../api";
import { Notice } from "./notice";

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

  if (error) return <Notice title="Can't load the cookie library">{error}</Notice>;
  if (!sets) return <Notice title="Loading" busy />;

  return (
    <section className="library" aria-label="Cookie library">
      <div className="library-head">
        <h1 className="library-title">Cookie library</h1>
        <p className="field-hint">
          Saved logins: cookies and localStorage captured from a session, loaded into new sessions
          with <code>cookieSets</code>.{" "}
          {encrypted ? "Encrypted at rest." : "Not encrypted at rest."}
        </p>
      </div>
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
              <th>First expiry</th>
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
                <td>{when(set.expiresAt)}</td>
                <td>{when(set.updatedAt)}</td>
                <td>
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
                      } finally {
                        setBusy(null);
                        refresh();
                      }
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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
