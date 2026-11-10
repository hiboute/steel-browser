import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  createSession,
  mutate,
  listBrowserProfiles,
  listVpnProviders,
  type EgressProfile,
  type BrowserProfileSummary,
  type SessionDetails,
} from "../api";
import { CookieSetPicker } from "./cookie-library";
import { KeyChip } from "./key-chip";
import { Segmented } from "./segmented";
import { useResource } from "../hooks";

type Device = "desktop" | "mobile";

const devices = [
  { value: "desktop", label: "Desktop" },
  { value: "mobile", label: "Mobile" },
] as const;

export function NewSessionButton({ onStarted }: { onStarted: (session: SessionDetails) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [device, setDevice] = useState<Device>("desktop");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState(0);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const text = (name: string) => String(data.get(name) ?? "").trim() || undefined;
    const width = text("width");
    const height = text("height");
    if (Boolean(width) !== Boolean(height)) {
      setError("Enter both width and height, or leave both empty.");
      return;
    }
    if (
      [Boolean(text("egress")), data.get("vpn") === "nordvpn", Boolean(text("proxyUrl"))].filter(
        Boolean,
      ).length > 1
    ) {
      setError("Choose one network option: a named network, NordVPN, or a proxy URL.");
      return;
    }
    const labels: Record<string, string> = {};
    for (const line of String(data.get("labels") || "")
      .split("\n")
      .filter((s) => s.trim())) {
      const index = line.indexOf("=");
      if (index <= 0) {
        setError("Enter labels as key=value, one per line.");
        return;
      }
      labels[line.slice(0, index).trim()] = line.slice(index + 1).trim();
    }

    setPending(true);
    setError(null);
    abort.current = new AbortController();
    try {
      const session = await createSession(
        {
          name: text("name"),
          labels,
          timeout: text("timeout") === undefined ? undefined : Number(text("timeout")) * 60000,
          idleTimeout:
            text("idleTimeout") === undefined ? undefined : Number(text("idleTimeout")) * 60000,
          onExpire: data.get("onExpire") === "release" ? "release" : "park",
          keepAlive: data.get("keepAlive") === "on",
          record: data.get("record") === "on",
          egress: text("egress"),
          identityProfile: text("identityProfile"),
          siteProfile: text("siteProfile"),
          mobileProfile: text("mobileProfile"),
          compatibilityMode: text("compatibilityMode") as
            | "native"
            | "compatible"
            | "legacy"
            | undefined,
          continuityPolicy:
            data.get("continuityPolicy") === "require-confirmation"
              ? "require-confirmation"
              : "warn",
          continuityToken: text("continuityToken"),
          egressPolicy: data.get("egressPolicy") === "strict" ? "strict" : "standard",
          siteScope: text("siteScope"),
          extensions: data.getAll("extensions").map(String),
          queueTimeout: 45000,
          deviceConfig: { device },
          dimensions:
            width && height ? { width: Number(width), height: Number(height) } : undefined,
          userAgent: text("userAgent"),
          blockAds: data.get("blockAds") === "on",
          cookieSets: data.getAll("cookieSets").map(String),
          browserProfile: text("browserProfile"),
          vpn:
            data.get("vpn") === "nordvpn"
              ? { provider: "nordvpn", country: text("vpnCountry")?.toUpperCase() }
              : undefined,
          proxyUrl: data.get("vpn") === "nordvpn" ? undefined : text("proxyUrl"),
        },
        abort.current.signal,
      );
      dialog.current?.close();
      form.reset();
      setDevice("desktop");
      onStarted(session);
    } catch (cause) {
      if (!abort.current.signal.aborted)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="button"
        data-variant="primary"
        data-shortcut="s"
        aria-keyshortcuts="S"
        aria-haspopup="dialog"
        onClick={() => {
          setOpened((n) => n + 1);
          dialog.current?.showModal();
        }}
      >
        Start session
        <KeyChip k="S" />
      </button>
      <dialog
        ref={dialog}
        className="dialog"
        aria-labelledby="new-session-title"
        aria-describedby="new-session-description"
        onClose={() => {
          abort.current?.abort();
          setError(null);
        }}
      >
        <form className="dialog-form" onSubmit={(event) => void submit(event)}>
          <div className="dialog-head">
            <h2 id="new-session-title" className="dialog-title">
              Start a new session
            </h2>
            <p id="new-session-description" className="dialog-description">
              Configure options and start a new session in a free browser.
            </p>
          </div>
          <div className="dialog-body">
            <label className="field">
              Name
              <input
                className="input"
                name="name"
                maxLength={80}
                placeholder="What is this browser for?"
              />
            </label>
            <div className="form-grid">
              <label className="field">
                Idle limit (minutes)
                <input
                  className="input"
                  name="idleTimeout"
                  type="number"
                  min={0}
                  step="any"
                  placeholder="Server default"
                />
              </label>
              <label className="field">
                Lifetime (minutes)
                <input
                  className="input"
                  name="timeout"
                  type="number"
                  min={0}
                  step="any"
                  placeholder="Server default"
                />
              </label>
            </div>
            <label className="field">
              On expiry
              <select className="input" name="onExpire">
                <option value="park">Park and keep state</option>
                <option value="release">Release and discard state</option>
              </select>
            </label>
            <div className="form-grid">
              <label className="check-row">
                <input name="keepAlive" type="checkbox" />
                Keep alive when idle
              </label>
              <label className="check-row">
                <input name="record" type="checkbox" />
                Record for replay
              </label>
            </div>
            <SessionExtras key={`extra${opened}`} />
            <IdentityOptions key={`identity${opened}`} />
            <div className="field">
              <span>Device</span>
              <Segmented label="Device" value={device} onChange={setDevice} options={devices} />
            </div>
            <div className="field" role="group" aria-labelledby="viewport-label">
              <span id="viewport-label">Viewport</span>
              <div className="viewport-inputs">
                <input
                  className="input"
                  name="width"
                  type="number"
                  inputMode="numeric"
                  min={320}
                  max={7680}
                  placeholder="1920"
                  aria-label="Width"
                />
                <span aria-hidden="true">×</span>
                <input
                  className="input"
                  name="height"
                  type="number"
                  inputMode="numeric"
                  min={240}
                  max={4320}
                  placeholder="1080"
                  aria-label="Height"
                />
              </div>
              <p className="field-hint">Leave empty to use the default size.</p>
            </div>
            <label className="field">
              <span>User agent</span>
              <input
                className="input"
                name="userAgent"
                placeholder="Default"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="field">
              <span>Proxy URL</span>
              <input
                className="input"
                name="proxyUrl"
                type="url"
                placeholder="http://user:pass@host:port"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="switch-row">
              <span className="switch-text">
                <span>Block ads</span>
                <span className="field-hint">Blocks requests to known ad hosts.</span>
              </span>
              <input
                className="switch"
                name="blockAds"
                type="checkbox"
                role="switch"
                defaultChecked
              />
            </label>
            <SavedBrowserField key={`b${opened}`} />
            <VpnField key={`v${opened}`} />
            <CookieSetPicker key={opened} />
            <details>
              <summary>Labels</summary>
              <label className="field">
                One key=value per line
                <textarea className="input" name="labels" rows={3} placeholder="project=research" />
              </label>
            </details>
            {pending && (
              <p role="status" className="field-hint">
                Waiting for a free browser, then starting your session. You can cancel this request.
              </p>
            )}
            {error && (
              <p className="dialog-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="dialog-foot">
            <button type="button" className="button" onClick={() => dialog.current?.close()}>
              Cancel
            </button>
            <button type="submit" className="button" data-variant="primary" disabled={pending}>
              {pending ? "Starting session…" : "Start session"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}

function SessionExtras() {
  const { data: networks } = useResource<{ profiles: EgressProfile[] }>("/v1/egress", 0);
  const { data: extensions } = useResource<{ extensions: { name: string; title: string }[] }>(
    "/v1/extensions",
    0,
  );
  return (
    <>
      <label className="field">
        Network
        <select name="egress" className="input">
          <option value="">Server or saved-login default</option>
          {networks?.profiles.map((p) => (
            <option key={p.name} value={p.name}>
              {p.label || p.name}
            </option>
          ))}
        </select>
      </label>
      {Boolean(extensions?.extensions.length) && (
        <fieldset className="field cookie-picker">
          <legend>Extensions</legend>
          {extensions?.extensions.map((e) => (
            <label className="cookie-option" key={e.name}>
              <input type="checkbox" name="extensions" value={e.name} />
              {e.title}
            </label>
          ))}
        </fieldset>
      )}
    </>
  );
}

function IdentityOptions() {
  const [preview, setPreview] = useState<any>(),
    [checking, setChecking] = useState(false),
    [previewError, setPreviewError] = useState<string | null>(null);
  const previewNetwork = async (button: HTMLButtonElement) => {
    const form = button.closest("form");
    if (!form) return;
    const data = new FormData(form);
    setChecking(true);
    setPreviewError(null);
    try {
      setPreview(
        await mutate("/v1/identity/continuity/preview", {
          identityProfile: String(data.get("identityProfile") || "") || undefined,
          browserProfile: String(data.get("browserProfile") || "") || undefined,
          cookieSets: data.getAll("cookieSets"),
          egress: String(data.get("egress") || "") || undefined,
        }),
      );
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : String(error));
    } finally {
      setChecking(false);
    }
  };
  const identities = useResource<{ profiles: { name: string; revision: number }[] }>(
    "/v1/identity-profiles",
    0,
  );
  const sites = useResource<{ profiles: { name: string; origin: string }[] }>(
    "/v1/site-profiles",
    0,
  );
  const mobile = useResource<{ profiles: { id: string; name?: string }[] }>(
    "/v1/mobile-profiles",
    0,
  );
  return (
    <details className="session-identity-options">
      <summary>Identity, mobile fidelity & continuity</summary>
      <p className="field-hint">
        Use coherent identity settings across sessions. Mobile profiles emulate Chromium; real
        devices are managed in Browser fleet.
      </p>
      {[identities.error, sites.error, mobile.error].filter(Boolean).map((error, index) => (
        <p key={index} role="alert" className="page-error">
          {error}
        </p>
      ))}
      <label className="field">
        Identity profile
        <select className="input" name="identityProfile">
          <option value="">Fresh identity</option>
          {identities.data?.profiles.map((profile) => (
            <option key={profile.name} value={profile.name}>
              {profile.name} · revision {profile.revision}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Site preferences
        <select className="input" name="siteProfile">
          <option value="">No site profile</option>
          {sites.data?.profiles.map((profile) => (
            <option key={profile.name} value={profile.name}>
              {profile.name} · {profile.origin}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Compatibility mode
        <select className="input" name="compatibilityMode">
          <option value="">Profile or server default</option>
          <option value="native">Native browser</option>
          <option value="compatible">Measured compatibility patches</option>
          <option value="legacy">Legacy compatibility</option>
        </select>
      </label>
      <label className="field">
        Mobile fidelity profile
        <select className="input" name="mobileProfile">
          <option value="">Use device selection below</option>
          {mobile.data?.profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name || profile.id}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Account network continuity
        <select className="input" name="continuityPolicy">
          <option value="warn">Report network drift</option>
          <option value="require-confirmation">Require confirmation before changing network</option>
        </select>
      </label>
      <label className="field">
        Continuity confirmation token
        <input
          className="input"
          name="continuityToken"
          autoComplete="off"
          placeholder="Only when confirming a reviewed network preview"
        />
      </label>
      <button
        type="button"
        className="pill-button"
        disabled={checking}
        onClick={(event) => void previewNetwork(event.currentTarget)}
      >
        {checking ? "Checking route…" : "Preview account network continuity"}
      </button>
      {previewError && (
        <p className="page-error" role="alert">
          {previewError}
        </p>
      )}
      {preview && (
        <div className="work-result">
          <p>
            Continuity: <strong>{preview.status}</strong>
          </p>
          <details>
            <summary>Observed route</summary>
            <pre>{JSON.stringify(preview, null, 2)}</pre>
          </details>
          {preview.confirmationToken && (
            <button
              type="button"
              className="pill-button"
              onClick={(event) => {
                const input = event.currentTarget
                  .closest("form")
                  ?.querySelector<HTMLInputElement>('input[name="continuityToken"]');
                if (input) input.value = preview.confirmationToken;
              }}
            >
              Accept this reviewed route for launch
            </button>
          )}
        </div>
      )}
      <label className="field">
        Network enforcement
        <select className="input" name="egressPolicy">
          <option value="standard">Standard</option>
          <option value="strict">Require strict proxy enforcement</option>
        </select>
      </label>
      <label className="field">
        Budget site origin
        <input className="input" name="siteScope" type="url" placeholder="https://example.com" />
      </label>
    </details>
  );
}

/**
 * Saved browser: run the session in a named Chrome profile kept on disk, so
 * a site sees the same browser (and its login) every time. Empty = a fresh
 * throwaway browser.
 */
function SavedBrowserField() {
  const [profiles, setProfiles] = useState<BrowserProfileSummary[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    listBrowserProfiles(controller.signal)
      .then(({ profiles }) => setProfiles(profiles))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);
  return (
    <label className="field">
      <span>Saved browser</span>
      <input
        className="input"
        name="browserProfile"
        list="saved-browsers"
        placeholder="None (fresh browser)"
        pattern="[a-zA-Z0-9._\-]{1,64}"
        autoComplete="off"
        spellCheck={false}
      />
      <datalist id="saved-browsers">
        {profiles.map((p) => (
          <option key={p.name} value={p.name}>
            {p.inUseBy ? "in use" : "saved"}
          </option>
        ))}
      </datalist>
      <p className="field-hint">
        Pick or name one to keep this browser (logins, cookies, device) for next time. One session
        at a time per saved browser.
      </p>
    </label>
  );
}

/** NordVPN exit for the session, when Steel has NordVPN service credentials. */
function VpnField() {
  const [available, setAvailable] = useState(false);
  const [on, setOn] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    listVpnProviders(controller.signal)
      .then(({ providers }) =>
        setAvailable(providers.some((p) => p.id === "nordvpn" && p.configured)),
      )
      .catch(() => undefined);
    return () => controller.abort();
  }, []);
  if (!available) return null;
  return (
    <div className="field">
      <label className="switch-row">
        <span className="switch-text">
          <span>NordVPN</span>
          <span className="field-hint">
            Browse through a NordVPN server (replaces the proxy URL).
          </span>
        </span>
        <input
          className="switch"
          name="vpn"
          value="nordvpn"
          type="checkbox"
          role="switch"
          checked={on}
          onChange={(e) => setOn(e.currentTarget.checked)}
        />
      </label>
      {on && (
        <input
          className="input"
          name="vpnCountry"
          placeholder="Country code, e.g. FR (empty: fastest)"
          pattern="[A-Za-z]{2}"
          maxLength={2}
          autoComplete="off"
          spellCheck={false}
          aria-label="NordVPN country"
        />
      )}
    </div>
  );
}
