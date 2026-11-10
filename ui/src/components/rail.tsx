import type { SessionDetails } from "../api";
import type { Tone } from "../format";
import { viewNames, type WorkspaceView } from "./workspace-pages";
import {
  ArrowUpRightIcon,
  BookIcon,
  BranchIcon,
  ChatIcon,
  RailIcon,
  SteelLogo,
  WindowIcon,
} from "./icons";

export type ApiStatus = "connecting" | "online" | "reconnecting" | "offline";

const problems: Partial<Record<ApiStatus, { label: string; tone: Tone }>> = {
  reconnecting: { label: "Reconnecting to the API…", tone: "yellow" },
  offline: { label: "Can't reach the API", tone: "red" },
};

const links = [
  { href: "https://docs.steel.dev", label: "Docs", icon: BookIcon },
  { href: "https://discord.gg/steel-dev", label: "Discord", icon: ChatIcon },
  { href: "https://github.com/hiboute/steel-browser", label: "GitHub", icon: BranchIcon },
];

function shortId(id: string) {
  return id.slice(0, 8);
}

function age(createdAt: string) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(createdAt).getTime()) / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}

function SessionItem({
  session,
  current,
  onSelect,
}: {
  session: SessionDetails;
  current: boolean;
  onSelect: (id: string) => void;
}) {
  const href = `?session=${encodeURIComponent(session.id)}`;
  return (
    <a
      className="rail-item rail-session"
      href={href}
      aria-current={current ? "page" : undefined}
      title={session.id}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        onSelect(session.id);
      }}
    >
      <span className="session-dot" data-status={session.status} />
      <span className="rail-item-label">
        {session.status === "idle" ? "Idle browser" : session.name || shortId(session.id)}
      </span>
      <span className="rail-item-meta">
        {session.status === "live" ? age(session.createdAt) : session.status}
      </span>
    </a>
  );
}

export function Rail({
  status,
  onCollapse,
  sessions,
  selectedId,
  onSelect,
  view,
  onView,
}: {
  status: ApiStatus;
  onCollapse: () => void;
  sessions: SessionDetails[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  view: WorkspaceView;
  onView: (view: WorkspaceView) => void;
}) {
  const problem = problems[status];
  const live = sessions.filter((s) => s.status === "live" || s.status === "idle");
  const parked = sessions.filter((s) => s.status === "parked");
  const released = sessions.filter((s) => s.status === "released").slice(0, 5);

  return (
    <aside className="rail" aria-label="Sidebar">
      <div className="rail-head">
        <SteelLogo
          className="rail-logo"
          role="img"
          aria-hidden={false}
          aria-label="Steel Browser"
        />
        <button
          type="button"
          className="bar-button"
          aria-label="Collapse sidebar"
          aria-expanded={true}
          title="Collapse sidebar"
          onClick={onCollapse}
        >
          <RailIcon />
        </button>
      </div>
      <nav className="rail-nav" aria-label="Main">
        <div className="rail-group">
          <p className="rail-group-title">Work</p>
          <div className="rail-items">
            {(
              [
                "home",
                "inbox",
                "automation",
                "recovery",
                "identity",
                "data",
                "fleet",
                "platform",
              ] as WorkspaceView[]
            ).map((key) => (
              <a
                key={key}
                className="rail-item"
                href={key === "home" ? import.meta.env.BASE_URL : `?view=${key}`}
                aria-current={view === key ? "page" : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  onView(key);
                }}
              >
                <span className="nav-symbol" aria-hidden="true">
                  {
                    (
                      {
                        home: "⌂",
                        inbox: "▣",
                        automation: "▷",
                        recovery: "↺",
                        identity: "◈",
                        data: "▤",
                        fleet: "⊞",
                        platform: "⚙",
                      } as Record<string, string>
                    )[key]
                  }
                </span>
                <span className="rail-item-label">{viewNames[key]}</span>
              </a>
            ))}
          </div>
        </div>
        <div className="rail-group">
          <p className="rail-group-title">Browsers</p>
          <div className="rail-items">
            <a
              className="rail-item"
              href="?view=sessions"
              aria-current={view === "sessions" ? "page" : undefined}
              onClick={(event) => {
                event.preventDefault();
                onView("sessions");
              }}
            >
              <WindowIcon />
              <span className="rail-item-label">Sessions</span>
            </a>
            <a
              className="rail-item"
              href="?view=cookies"
              aria-current={view === "cookies" ? "page" : undefined}
              onClick={(event) => {
                event.preventDefault();
                onView("cookies");
              }}
            >
              <BookIcon />
              <span className="rail-item-label">Saved logins</span>
            </a>
            {(
              [
                "pool",
                "watchers",
                "warm",
                "extensions",
                "network",
                "extract",
                "operations",
              ] as WorkspaceView[]
            ).map((key) => (
              <a
                key={key}
                className="rail-item"
                href={`?view=${key}`}
                aria-current={view === key ? "page" : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  onView(key);
                }}
              >
                <span className="nav-symbol" aria-hidden="true">
                  {
                    (
                      {
                        pool: "◫",
                        watchers: "◎",
                        warm: "⌁",
                        extensions: "▧",
                        network: "↗",
                        extract: "⇩",
                        operations: "≡",
                      } as Record<string, string>
                    )[key]
                  }
                </span>
                <span className="rail-item-label">{viewNames[key]}</span>
              </a>
            ))}
          </div>
        </div>
        <div className="rail-group">
          <p className="rail-group-title">
            Live {live.some((s) => s.status === "live") && <span>({live.length})</span>}
          </p>
          <div className="rail-items">
            {live.map((session) => (
              <SessionItem
                key={session.id}
                session={session}
                current={view === "sessions" && session.id === selectedId}
                onSelect={onSelect}
              />
            ))}
          </div>
        </div>
        {parked.length > 0 && (
          <div className="rail-group">
            <p className="rail-group-title">Parked ({parked.length})</p>
            <div className="rail-items">
              {parked.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  current={view === "sessions" && session.id === selectedId}
                  onSelect={onSelect}
                />
              ))}
            </div>
          </div>
        )}
        {released.length > 0 && (
          <div className="rail-group">
            <p className="rail-group-title">Released</p>
            <div className="rail-items">
              {released.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  current={session.id === selectedId}
                  onSelect={onSelect}
                />
              ))}
            </div>
          </div>
        )}
        <div className="rail-group">
          <p className="rail-group-title">External</p>
          <div className="rail-items">
            {links.map(({ href, label, icon: Icon }) => (
              <a key={href} className="rail-item" href={href} target="_blank" rel="noreferrer">
                <Icon />
                <span className="rail-item-label">{label}</span>
                <ArrowUpRightIcon className="rail-item-trail" />
              </a>
            ))}
          </div>
        </div>
      </nav>
      {problem && (
        <div className="rail-foot">
          <div className="api-status" role="status" data-tone={problem.tone}>
            <span className="api-status-dot" />
            {problem.label}
          </div>
        </div>
      )}
    </aside>
  );
}
