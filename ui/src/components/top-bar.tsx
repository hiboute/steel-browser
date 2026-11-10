import { type SessionDetails } from "../api";
import { CopyButton } from "./copy-button";
import { ChevronRightIcon, ConsoleIcon, DevToolsIcon, RailIcon } from "./icons";
import { NewSessionButton } from "./new-session";
import { ReleaseButton } from "./release-button";
import { SaveCookiesButton } from "./cookie-library";
import { SessionActions, deadline } from "./session-tools";
import { viewNames, type WorkspaceView } from "./workspace-pages";

export function TopBar({
  session,
  railOpen,
  onToggleRail,
  consoleOpen,
  onToggleConsole,
  devtoolsOpen,
  onToggleDevtools,
  onSessionChange,
  view = "sessions",
}: {
  session: SessionDetails | null | undefined;
  railOpen: boolean;
  onToggleRail: () => void;
  consoleOpen: boolean;
  onToggleConsole: () => void;
  devtoolsOpen: boolean;
  onToggleDevtools: () => void;
  onSessionChange: (session?: SessionDetails) => void;
  view?: WorkspaceView;
}) {
  const consoleLabel = consoleOpen ? "Hide logs" : "Show logs";
  const devtoolsLabel = devtoolsOpen ? "Hide DevTools" : "Show DevTools";

  return (
    <header className="top-bar">
      {!railOpen && (
        <button
          type="button"
          className="bar-button rail-toggle"
          aria-label="Expand sidebar"
          aria-expanded={false}
          title="Expand sidebar"
          onClick={onToggleRail}
        >
          <RailIcon />
        </button>
      )}
      {session && (
        <button
          type="button"
          className="bar-button"
          aria-label={consoleLabel}
          aria-pressed={consoleOpen}
          title={consoleLabel}
          onClick={onToggleConsole}
        >
          <ConsoleIcon />
        </button>
      )}
      {session?.debugUrl && session.status === "live" && (
        <button
          type="button"
          className="bar-button devtools-toggle"
          aria-label={devtoolsLabel}
          aria-pressed={devtoolsOpen}
          title={devtoolsLabel}
          onClick={onToggleDevtools}
        >
          <DevToolsIcon />
        </button>
      )}
      <nav className="crumbs" aria-label="Breadcrumb">
        <span className="crumb-parent">{viewNames[view]}</span>
        {session && view === "sessions" && (
          <>
            <ChevronRightIcon className="crumb-sep" />
            <span className="crumb-current" aria-current="page" title={session.id}>
              {session.name || session.id}
            </span>
            <CopyButton className="crumb-copy" value={session.id} label="Copy session ID" />
            <span className="expiry-label">{deadline(session)}</span>
          </>
        )}
      </nav>
      <div className="top-bar-actions">
        {session && view === "sessions" && (
          <SessionActions session={session} onChange={onSessionChange} />
        )}
        {session &&
          view === "sessions" &&
          (session.status === "live" || session.status === "idle") && (
            <SaveCookiesButton session={session} />
          )}
        {session &&
          view === "sessions" &&
          (session.status === "live" || session.status === "parked") && (
            <ReleaseButton sessionId={session.id} onReleased={() => onSessionChange()} />
          )}
        <NewSessionButton onStarted={onSessionChange} />
      </div>
    </header>
  );
}
