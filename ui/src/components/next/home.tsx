import type { ReactNode } from "react";
import type { CookieSetSummary, PoolStatus } from "../../api";
import { useResource } from "../../hooks";
import { bytes } from "../session-tools";
import { Page, type WorkspaceView } from "../workspace-pages";

type Inbox = {
  items: {
    id: string;
    kind: string;
    sessionId?: string;
    title: string;
    description?: string;
    updatedAt: string;
    dismissedAt: string | null;
    actions: string[];
  }[];
};
type Watchers = {
  watchers: {
    id: string;
    name: string;
    enabled: boolean;
    notify: { onErrorAfter: number };
    state: { lastRunAt?: string; consecutiveErrors: number };
  }[];
};
type HardSites = { sites: { origin: string; hits: number; lastAt: string }[] };
type Scorecards = {
  defaultMode: string;
  scorecards: { at: string; recommended?: string; modes: { mode: string; score?: number }[] }[];
};
type Storage = { totalBytes: number; lastPrune?: { at: string } };

export interface HomeItem {
  key: string;
  /** Lower comes first. */
  rank: number;
  badge: string;
  bad?: boolean;
  title: string;
  text?: string;
  at?: string;
  action: string;
  view?: WorkspaceView;
  sessionId?: string;
}
export interface HomeSources {
  inbox?: Inbox;
  cookies?: CookieSetSummary[];
  watchers?: Watchers;
  hardSites?: HardSites;
  pool?: PoolStatus;
}

const host = (origin: string) => origin.replace(/^https?:\/\//, "");

/** Everything that waits for a person, most urgent first. */
export function homeItems(s: HomeSources): HomeItem[] {
  const items: HomeItem[] = [];
  for (const card of s.inbox?.items ?? []) {
    if (card.dismissedAt || !card.actions.some((action) => action !== "open")) continue;
    const handoff = card.kind === "handoff";
    items.push({
      key: `inbox:${card.id}`,
      rank: handoff ? 0 : card.kind === "review" ? 1 : 5,
      badge: handoff ? "Waiting" : card.kind === "review" ? "Review" : card.kind,
      bad: handoff,
      title: card.title,
      text: card.description,
      at: card.updatedAt,
      action: handoff && card.sessionId ? "Open live view" : "Open in inbox",
      ...(handoff && card.sessionId ? { sessionId: card.sessionId } : { view: "inbox" as const }),
    });
  }
  for (const set of s.cookies ?? []) {
    const status = set.health?.status;
    if (status !== "expired" && status !== "failing" && status !== "expiring") continue;
    const expires = set.authExpiresAt ?? set.expiresAt;
    items.push({
      key: `login:${set.name}`,
      rank: status === "expiring" ? 6 : 2,
      badge: status,
      bad: status !== "expiring",
      title:
        status === "expiring"
          ? `Saved login "${set.name}" expires soon`
          : status === "expired"
          ? `Saved login "${set.name}" has expired`
          : `Saved login "${set.name}" no longer signs in`,
      text:
        status === "failing"
          ? set.health?.lastResult?.reason || "Its last login check failed."
          : "Open the site once with this login to renew it.",
      at: status === "failing" ? set.health?.lastCheckAt : expires ?? undefined,
      action: "Open saved logins",
      view: "cookies",
    });
  }
  for (const site of s.hardSites?.sites ?? [])
    items.push({
      key: `site:${site.origin}`,
      rank: 3,
      badge: "Blocked",
      bad: true,
      title: `${host(site.origin)} stopped Steel ${site.hits} times`,
      text: "A paired desktop browser, or a person, gets through where Steel's own browser does not.",
      at: site.lastAt,
      action: "See fleet",
      view: "fleet",
    });
  for (const watcher of s.watchers?.watchers ?? []) {
    if (
      !watcher.enabled ||
      watcher.state.consecutiveErrors < Math.max(watcher.notify.onErrorAfter, 1)
    )
      continue;
    items.push({
      key: `watcher:${watcher.id}`,
      rank: 4,
      badge: "Failing",
      bad: true,
      title: `Watcher "${watcher.name}" keeps failing`,
      text: `${watcher.state.consecutiveErrors} checks in a row did not complete.`,
      at: watcher.state.lastRunAt,
      action: "Open watchers",
      view: "watchers",
    });
  }
  if (s.pool?.queued)
    items.push({
      key: "pool:queue",
      rank: 4,
      badge: "Queue",
      title: `${s.pool.queued} ${
        s.pool.queued === 1 ? "browser is" : "browsers are"
      } waiting for a free slot`,
      text: "Park or close a browser you no longer need.",
      action: "Open pool",
      view: "pool",
    });
  if (s.pool?.memory?.pressure)
    items.push({
      key: "pool:memory",
      rank: 4,
      badge: "Memory",
      bad: true,
      title: "Memory is low",
      text: `${bytes(
        s.pool.memory.availableBytes,
      )} available. New browsers wait until some is freed.`,
      action: "Open pool",
      view: "pool",
    });
  return items.sort(
    (a, b) =>
      a.rank - b.rank || (b.at ?? "").localeCompare(a.at ?? "") || a.key.localeCompare(b.key),
  );
}

export function ago(at: string | undefined, now = Date.now()) {
  if (!at) return "";
  const minutes = Math.round((now - new Date(at).getTime()) / 60_000);
  if (Number.isNaN(minutes)) return "";
  const future = minutes < 0,
    m = Math.abs(minutes);
  const span =
    m < 1
      ? "now"
      : m < 60
      ? `${m} min`
      : m < 1440
      ? `${Math.round(m / 60)} h`
      : `${Math.round(m / 1440)} d`;
  return span === "now" ? span : future ? `in ${span}` : `${span} ago`;
}

export function HomePage({
  onView,
  onSession,
}: {
  onView: (view: WorkspaceView) => void;
  onSession: (id: string) => void;
}) {
  const inbox = useResource<Inbox>("/v1/inbox?includeDismissed=false", 3000),
    cookies = useResource<{ sets: CookieSetSummary[] }>("/v1/cookie-library", 30000),
    watchers = useResource<Watchers>("/v1/watchers", 15000),
    hardSites = useResource<HardSites>("/v1/hard-sites", 30000),
    pool = useResource<PoolStatus>("/v1/pool", 3000),
    scorecards = useResource<Scorecards>("/v1/identity/scorecards?limit=1", 60000),
    storage = useResource<Storage>("/v1/storage", 60000);
  const sets = cookies.data?.sets;
  const items = homeItems({
    inbox: inbox.data,
    cookies: sets,
    watchers: watchers.data,
    hardSites: hardSites.data,
    pool: pool.data,
  });
  const loading = inbox.data === undefined && !inbox.error;
  const missing = [
    inbox.error && "inbox",
    cookies.error && "saved logins",
    watchers.error && "watchers",
    hardSites.error && "blocked sites",
    pool.error && "pool",
  ].filter(Boolean);
  const card = scorecards.data?.scorecards[0],
    best = card?.modes.find((mode) => mode.mode === card.recommended),
    active = watchers.data?.watchers.filter((w) => w.enabled) ?? [],
    failing = items.filter((item) => item.key.startsWith("watcher:")).length,
    badLogins = items.filter((item) => item.key.startsWith("login:")).length;
  const link = (view: WorkspaceView, children: ReactNode) => (
    <a
      href={`?view=${view}`}
      onClick={(event) => {
        event.preventDefault();
        onView(view);
      }}
    >
      {children}
    </a>
  );
  return (
    <Page
      title="Home"
      description={
        items.length
          ? "What needs you, most urgent first. Everything else is fine."
          : missing.length
          ? "Some of Steel could not be checked."
          : "Nothing needs you right now."
      }
    >
      {!!missing.length && (
        <p className="field-hint" role="status">
          Could not load: {missing.join(", ")}. The list below may be incomplete.
        </p>
      )}
      {loading ? (
        <p className="empty-state">Loading…</p>
      ) : items.length ? (
        <ul className="home-list" aria-label="Needs you">
          {items.map((item) => (
            <li key={item.key} className="resource-card home-item">
              <span className={`badge${item.bad ? " bad" : ""}`}>{item.badge}</span>
              <div className="home-item-text">
                <h2>{item.title}</h2>
                {item.text && <p>{item.text}</p>}
              </div>
              <small>{ago(item.at)}</small>
              <button
                type="button"
                className={item.rank === 0 ? "button" : "pill-button"}
                data-variant={item.rank === 0 ? "primary" : undefined}
                onClick={() => (item.sessionId ? onSession(item.sessionId) : onView(item.view!))}
              >
                {item.action}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty-state">
          {missing.length
            ? "Nothing needs you in what could be checked."
            : "No browser is waiting, no review is pending, and saved logins and watchers are healthy."}
        </p>
      )}
      <h2 className="home-section">Everything else</h2>
      <div className="resource-card home-quiet">
        {pool.data &&
          link(
            "pool",
            <>
              <strong>
                {pool.data.live} / {pool.data.maxSessions}
              </strong>{" "}
              browsers, {pool.data.parked ?? 0} parked
            </>,
          )}
        {scorecards.data &&
          link(
            "identity",
            best?.score !== undefined ? (
              <>
                Stealth <strong>{best.score}</strong> ({card!.recommended}, measured {ago(card!.at)}
                )
              </>
            ) : (
              <>Stealth not measured yet</>
            ),
          )}
        {storage.data &&
          link(
            "platform",
            <>
              <strong>{bytes(storage.data.totalBytes)}</strong> on disk
              {storage.data.lastPrune && `, cleaned ${ago(storage.data.lastPrune.at)}`}
            </>,
          )}
        {watchers.data &&
          link(
            "watchers",
            <>
              <strong>{active.length}</strong> {active.length === 1 ? "watcher" : "watchers"}
              {active.length ? (failing ? `, ${failing} failing` : ", all passing") : ""}
            </>,
          )}
        {sets &&
          link(
            "cookies",
            <>
              <strong>{sets.length}</strong> saved {sets.length === 1 ? "login" : "logins"}
              {sets.length ? (badLogins ? `, ${badLogins} to renew` : ", all healthy") : ""}
            </>,
          )}
      </div>
    </Page>
  );
}
