import { Notice } from "./components/notice";
import { Rail, type ApiStatus } from "./components/rail";
import { SessionConsole } from "./components/session-console";
import { Stage } from "./components/stage";
import { TopBar } from "./components/top-bar";
import type { SessionDetails } from "./api";
import { useSessions, useShortcutKeys, useStoredToggle, useUrlParam } from "./hooks";
import { CookieLibraryPage } from "./components/cookie-library";

export function App() {
  const { sessions, error, refresh } = useSessions();
  const [selectedId, selectSession] = useUrlParam("session");
  const [view, setView] = useUrlParam("view");
  const select = (id: string | null) => {
    if (view) setView(null);
    selectSession(id);
  };
  // The picked session while it is listed; otherwise the newest live one.
  const session: SessionDetails | null | undefined =
    sessions === undefined
      ? undefined
      : sessions.find((s) => s.id === selectedId) ?? sessions[0] ?? null;
  const onSessionChange = (started?: SessionDetails) => {
    if (started) select(started.id);
    else if (session && selectedId === session.id) select(null);
    refresh();
  };
  const [railOpen, toggleRail] = useStoredToggle("steel-browser:rail", true);
  const [consoleOpen, toggleConsole] = useStoredToggle("steel-browser:console", true);
  const [devtoolsOpen, toggleDevtools] = useStoredToggle("steel-browser:devtools", false);
  useShortcutKeys();

  const status: ApiStatus = error
    ? session
      ? "reconnecting"
      : "offline"
    : session === undefined
    ? "connecting"
    : "online";

  return (
    <div className="shell" data-rail={railOpen ? "open" : "closed"}>
      {railOpen && (
        <Rail
          status={status}
          onCollapse={toggleRail}
          sessions={sessions ?? []}
          selectedId={session?.id ?? null}
          onSelect={select}
          view={view === "cookies" ? "cookies" : "sessions"}
          onView={(next) => setView(next === "cookies" ? "cookies" : null)}
        />
      )}
      <div className="body">
        <main className="panel">
          <TopBar
            session={session}
            railOpen={railOpen}
            onToggleRail={toggleRail}
            consoleOpen={consoleOpen}
            onToggleConsole={toggleConsole}
            devtoolsOpen={devtoolsOpen}
            onToggleDevtools={toggleDevtools}
            onSessionChange={onSessionChange}
          />
          {view === "cookies" ? (
            <CookieLibraryPage />
          ) : session ? (
            <div className="workspace">
              <SessionConsole key={session.id} session={session} hidden={!consoleOpen} />
              <Stage session={session} devtoolsOpen={devtoolsOpen} />
            </div>
          ) : error ? (
            <Notice title="Can't reach the Steel API">
              Make sure the API is running. This page reconnects on its own.
            </Notice>
          ) : session === null ? (
            <Notice title="No session">
              Start one with <code>POST /v1/sessions</code>.
            </Notice>
          ) : (
            <Notice title="Connecting" busy />
          )}
        </main>
      </div>
    </div>
  );
}
