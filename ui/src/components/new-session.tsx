import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  createSession,
  listBrowserProfiles,
  listVpnProviders,
  type BrowserProfileSummary,
  type SessionDetails,
} from "../api";
import { CookieSetPicker } from "./cookie-library";
import { KeyChip } from "./key-chip";
import { Segmented } from "./segmented";

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

    setPending(true);
    setError(null);
    try {
      const session = await createSession({
        deviceConfig: { device },
        dimensions: width && height ? { width: Number(width), height: Number(height) } : undefined,
        userAgent: text("userAgent"),
        blockAds: data.get("blockAds") === "on",
        cookieSets: data.getAll("cookieSets").map(String),
        browserProfile: text("browserProfile"),
        vpn:
          data.get("vpn") === "nordvpn"
            ? { provider: "nordvpn", country: text("vpnCountry")?.toUpperCase() }
            : undefined,
        proxyUrl: data.get("vpn") === "nordvpn" ? undefined : text("proxyUrl"),
      });
      dialog.current?.close();
      form.reset();
      setDevice("desktop");
      onStarted(session);
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
        onClose={() => setError(null)}
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
            {error && (
              <p className="dialog-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="dialog-foot">
            <button
              type="button"
              className="button"
              disabled={pending}
              onClick={() => dialog.current?.close()}
            >
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
      .then(({ providers }) => setAvailable(providers.some((p) => p.id === "nordvpn" && p.configured)))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);
  if (!available) return null;
  return (
    <div className="field">
      <label className="switch-row">
        <span className="switch-text">
          <span>NordVPN</span>
          <span className="field-hint">Browse through a NordVPN server (replaces the proxy URL).</span>
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
