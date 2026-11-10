import { Notice } from "./components/notice";
import { Rail, type ApiStatus } from "./components/rail";
import { SessionConsole } from "./components/session-console";
import { Stage } from "./components/stage";
import { TopBar } from "./components/top-bar";
import { sessionPath, type SessionDetails } from "./api";
import { useResource, useSessions, useShortcutKeys, useStoredToggle, useUrlParam } from "./hooks";
import { CookieLibraryPage } from "./components/cookie-library";
import {
  ExtensionsPage,
  ExtractPage,
  NetworkPage,
  OperationsPage,
  PoolPage,
  PoolSummary,
  WarmPage,
  WatchersPage,
  viewNames,
  type WorkspaceView,
} from "./components/workspace-pages";
import { HandoffBanner, SessionHistory } from "./components/session-tools";
import {
  InboxPage,
  RecoveryPage,
  SessionWorkbench,
  ControlHeartbeat,
} from "./components/next/workbench";
import { AutomationPage } from "./components/next/automation";
import { IdentityPage } from "./components/next/identity";
import { DataPage } from "./components/next/data";
import { FleetPage } from "./components/next/fleet";
import { HomePage } from "./components/next/home";
import { PlatformPage } from "./components/next/platform";

export function App() {
  const { sessions, error: sessionsError, refresh } = useSessions();
  const [selectedId, selectSession] = useUrlParam("session");
  const [view, setView] = useUrlParam("view");
  const currentView: WorkspaceView =
    view && view in viewNames ? (view as WorkspaceView) : selectedId ? "sessions" : "home";
  // The bare address is Home; a browser link (?session=) opens that browser.
  const select = (id: string | null) => {
    setView(id ? null : "sessions");
    selectSession(id);
  };
  const selected = useResource<SessionDetails>(
    selectedId && sessions && !sessions.some((session) => session.id === selectedId)
      ? sessionPath(selectedId)
      : null,
    3000,
  );
  const error = sessionsError || selected.error;
  // Never display another browser while an explicitly selected one is loading.
  const session: SessionDetails | null | undefined =
    sessions === undefined
      ? undefined
      : selectedId
      ? sessions.find((s) => s.id === selectedId) ?? selected.data
      : sessions[0] ?? null;
  const onSessionChange = (started?: SessionDetails) => {
    if (started) select(started.id);
    else if (session && selectedId === session.id) select(null);
    refresh();
  };
  const [railOpen, toggleRail] = useStoredToggle("steel-browser:rail", window.innerWidth > 900);
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
      <ControlHeartbeat />
      {railOpen && (
        <Rail
          status={status}
          onCollapse={toggleRail}
          sessions={sessions ?? []}
          selectedId={session?.id ?? null}
          onSelect={(id) => {
            select(id);
            if (window.innerWidth <= 900) toggleRail();
          }}
          view={currentView}
          onView={(next) => {
            if (next === "home") selectSession(null);
            setView(next === "home" ? null : next);
            if (window.innerWidth <= 900) toggleRail();
          }}
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
            view={currentView}
          />
          <PoolSummary />
          {currentView === "home" ? (
            <HomePage onView={(next) => setView(next)} onSession={(id) => select(id)} />
          ) : currentView === "inbox" ? (
            <InboxPage />
          ) : currentView === "automation" ? (
            <AutomationPage session={session} />
          ) : currentView === "recovery" ? (
            <RecoveryPage session={session} />
          ) : currentView === "identity" ? (
            <IdentityPage session={session} />
          ) : currentView === "data" ? (
            <DataPage session={session} />
          ) : currentView === "fleet" ? (
            <FleetPage />
          ) : currentView === "platform" ? (
            <PlatformPage session={session} />
          ) : currentView === "cookies" ? (
            <CookieLibraryPage />
          ) : currentView === "pool" ? (
            <PoolPage />
          ) : currentView === "watchers" ? (
            <WatchersPage />
          ) : currentView === "warm" ? (
            <WarmPage />
          ) : currentView === "extensions" ? (
            <ExtensionsPage />
          ) : currentView === "network" ? (
            <NetworkPage />
          ) : currentView === "extract" ? (
            <ExtractPage />
          ) : currentView === "operations" ? (
            <OperationsPage />
          ) : session ? (
            <div className="session-workspace">
              <SessionWorkbench key={`workbench:${session.id}`} session={session} />
              <HandoffBanner session={session} />
              <div className="workspace">
                <SessionConsole key={session.id} session={session} hidden={!consoleOpen} />
                <Stage session={session} devtoolsOpen={devtoolsOpen} />
              </div>
              <SessionHistory key={`history:${session.id}`} session={session} />
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
