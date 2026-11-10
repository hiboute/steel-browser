# Feature roadmap: implementation and deployment status

The owner selected the complete roadmap below for PR #7, including the companion
MCP, harness and deployment work. The initial architecture draft targeted fork
main `ef515aa`; the PR incorporates main `0469ef1`. The specification below is
retained as the accepted scope. The operator-facing contract and configuration
are in [SESSION-PLATFORM.md](SESSION-PLATFORM.md) and
[MULTI_SESSION.md](../MULTI_SESSION.md).

## Implementation status

Checked items describe source implementation and local validation, not a live
production rollout. Final deployment evidence belongs in the separate checklist.

- [x] Session foundation: explicit slot lifecycle, FIFO queue, timeout/disconnect
      handling, targeted release, scoped reads, truthful health and proxy redaction.
- [x] Lifetime and idle expiry, activity tracking, touch/update routes, reaper,
      keep-alive/job/handoff exemptions and queue preemption.
- [x] Park/resume with retained profiles, cookie/tab/scroll/sessionStorage capture,
      thumbnails, metadata reload, expiry/limits and shutdown parking.
- [x] Pool/process/memory reporting, admission guard, session-scoped files and retention.
- [x] Platform events, notifications, audit, metrics, encrypted atomic storage,
      background jobs and named/NordVPN egress.
- [x] Cookie-library health checks and scheduling, expiry/recovery notifications,
      write-back/restore, identity pins, client access rules and audit events.
- [x] Human handoff, activity timeline/screenshots, opt-in CDP recording and replay API.
- [x] Warm browsers, structured extraction with schema validation/repair, page
      watchers, extension ZIP/CRX library and upstream-sync workflow.
- [x] UI operator surfaces for sessions, pool, logins, handoff, timeline, files,
      recordings, automation, egress, extraction, notifications and audit.
- [x] Three UI design directions prepared; Workshop is the selected default.
- [x] Harness session selection, scoped CDP targets and closed-panel polling fixes.
- [x] Companion MCP implementation and generated 28-tool catalog; production verification follows the release.
- [x] Harness visual controls and live harness deployment (PRs #35 and #36).
- [x] Final cross-package regression run and OpenAPI/generated-client refresh.

Validation completed during implementation includes focused lifecycle, HTTP,
store, login, agent-feature and extras tests; API/UI production builds; real
Chromium login/ACL/write-back and handoff/recording/restart checks; and an operator
UI browser flow covering creation, handoff, login capture, recording, files,
parking/resume, watcher/warm work and extraction against a deterministic local LLM.
The final feature/core API run passes 464 tests across 63 files, with Chromium and
heavy scrape checks enabled. Another nine CDP interception tests pass in isolated
Chromium. The unchanged command engine passes 234 of 238 tests using temporary
localhost fixture aliases in an isolated container: three existing accessible-name
whitespace mismatches and one pseudo-element description mismatch remain. Command
implementation and tests match base main `0469ef1`. MCP passes 131 tests; the UI
browser smoke passes 13 checks. API and UI production builds pass.

The isolated browser runs preserve managed host policies. The fixture adaptation
is not a repository change. Production release SHAs and checks are recorded below
once rollout finishes.

## Deployment verification

- [ ] Push the final reviewed Steel commit and update PR #7's complete scope.
- [ ] Update both pinned Steel API/UI commits in homelab and verify compose settings.
- [ ] Provision/verify data encryption, notification webhook, home proxy credentials
      and the Steel LiteLLM key without replacing existing credential/profile volumes.
- [ ] Apply the home egress proxy configuration and verify its actual outbound IP.
- [ ] Verify the real notification destination and LLM provider/model.
- [ ] Deploy Steel API, UI and MCP; verify their running versions and health.
- [ ] Deploy the harness changes and verify the agent follows its own live session.
- [ ] Verify production queue/expiry/park/resume/restart, login maintenance,
      handoff, recording, downloads, watchers, warm browsers and extension loading.
- [ ] Confirm upstream-sync and homelab pin-bump workflows are installed and runnable.

No API token on steel-api was selected. Existing authentication/network controls
remain the access boundary; `X-Steel-Client` is caller attribution, not authentication.

## Features picked


First batch (original motivation and selected behavior):
- (2) Idle timeout and slot reaper. Originally `timeout` was accepted but never enforced; MCP default
  sessions could fill all four slots indefinitely. Release/park after N minutes with no activity,
  honor `timeout`, show "releases in 12 min" in the UI.
- (3) Wait for a slot instead of 429: POST /v1/sessions can queue (FIFO) until a slot frees.
- (4) Cookie set health and auto-refresh: per set, expiry of its auth cookies, an optional "am I logged
  in" check (URL + selector), a nightly check, a notification when a login lapses; when a session
  started from a set ends, its fresher cookies are written back to the set.
- (5) Human handoff: agent calls `browser_request_human(reason)`; a notification with the live view link
  goes out ("captcha on site X", "2FA code needed"); the agent waits until the human clicks Done in the
  viewer or harness panel, then carries on.
- (P) Parking: "a way to park sessions, so that I can start a new one and come back later to the
  parked one". Parking frees the Chrome slot but keeps the session's state so it can be resumed later.

Next tier:
- (6) Egress choice per session: VPS IP, home IP (via the Mac mini / WireGuard / a proxy at home), or a
  named proxy. A cookie set can pin its egress.
- (7) Stable fingerprint per cookie set: same UA, viewport, timezone, locale each time a set is used.
- (8) Agent action timeline: every MCP call (navigate, click, type, evaluate) logged against its session
  with a small screenshot; shown in the session page and the harness panel.
- (9) Session recording and replay: opt-in, kept 7 days, scrub through it next to the timeline.
- (10) Harness panel follows the right session: show the session the harness's own agent is using, with
  a switcher for the others (today it watches the primary browser only).
- (11) Pinned warm sessions: a named session (say "gmail") that stays up on a reserved slot with its
  cookie set so agents attach instantly.
- (12) Structured extract endpoint: POST /v1/extract { url, schema }: readability + JSON-schema
  extraction through LiteLLM model `spark`, with cookie sets.
- (13) Page watchers: scheduled checks of a page (with a cookie set) that notify on a change or a
  condition.

Housekeeping and ops:
- (14) Memory guard and per-Chrome stats: each slot's RAM and tab count; refuse a new slot when free
  memory is low instead of letting the container OOM.
- (15) Prometheus /metrics: live sessions, queue length, 429s, reaped sessions, Chrome RSS, cookie set
  expiries.
- (16) Cookie set access rules and audit log: which MCP clients may load which sets; a log of who loaded
  what and when.
- (17) Downloads panel: list and fetch the files a session downloaded, from the UI and the harness.
- (18) Upstream sync workflow: weekly GitHub workflow that merges steel-dev main into the fork in a PR,
  runs the tests, and on merge bumps the pinned commit in homelab `vps/mcp-steel/compose.yaml`.
- (19) Chrome extensions per session: load unpacked extensions into chosen sessions.


## Accepted API and architecture specification


Scope: features 2-19 (not 1) plus parking. Built on top of saved browsers (`browserProfile`, `/v1/browser-profiles`,
BROWSER_PROFILES_DIR, one live session per profile, fingerprint stored per profile).

### 0. Conventions

- Routes under `/v1`, JSON, errors `{ success: false, code, message }`. Durations in ms, timestamps ISO.
- Every new request or response field MUST be added to the zod schemas (Fastify strips unknown fields both ways),
  then `npm run generate:openapi -w api` and `npm run generate-api -w ui` (generated types only; no visual UI change).
- The existing UI and the current MCP wrapper must keep working unchanged: new behavior is opt-in per request or by env,
  and code defaults reproduce today's behavior. The homelab compose turns features on.
- Caller identity: header `X-Steel-Client` (<= 128 chars, e.g. `mcp:<email>`, `harness:<login>`, `ui`), exposed as
  `request.steelClient`, default `anonymous`. Not authentication. Traefik forces `ui` on the public routers.
- State on disk under `STEEL_DATA_DIR` (default `<cwd>/data`; one volume in production): `parked/`, `files/`,
  `timeline/`, `recordings/`, `audit/`, `watchers/`, `warm.json`, `notifications.jsonl`. Files holding cookies or
  credentials use the cookie library envelope (AES-256-GCM, key = sha256(STEEL_DATA_KEY || COOKIE_LIBRARY_KEY)), plain
  when no key. Writes are atomic (tmp + rename).
- No new npm dependencies unless unavoidable (worktrees share one node_modules; duckdb takes 33 min to build).
- No em dash anywhere. Commits as the owner, no AI attribution.

### 1. Foundation (PR A): sessions and platform

### 1.1 Slot state machine
`PoolSlot.state`: `free | starting | live | stopping` (slot 0 `free` means "idle Chrome up, no session"). A slot
becomes `free` only after the previous Chrome is fully down (and, on slot 0, after the idle relaunch). `acquire` only
takes `free` slots. All start/stop/park/resume operations on one slot are serialized.

### 1.2 Session fields
Create (`POST /v1/sessions`), all optional: `name` (<= 80), `labels` (string map, <= 20 keys), `timeout` (max
lifetime, 0 = none), `idleTimeout` (0 = never), `onExpire` (`park` | `release`), `keepAlive` (bool), `queueTimeout`,
`egress` (name; exclusive with `proxyUrl`), `record` (bool), `cookieSetWriteBack` (bool, default true), `fingerprint`
(pass-through, already supported by the service). Env defaults: `SESSION_TIMEOUT_MS=0`, `SESSION_IDLE_TIMEOUT_MS=0`,
`SESSION_EXPIRE_ACTION=park`, `SESSION_QUEUE_TIMEOUT_MS=0`, `SESSION_QUEUE_MAX_MS=600000`.

`SessionDetails` adds: `name`, `labels`, `client`, `slot`, `status` + `parked`, `lastActivityAt`, `idleTimeout`,
`timeout` (real value), `onExpire`, `keepAlive`, `expiresAt` (ISO or null), `parkedAt`, `parkReason`
(`manual|idle|timeout|preempted|shutdown`), `resumeCount`, `releaseReason`
(`api|idle|timeout|disconnected|parked_expired|shutdown`), `cookieSets`, `egress`, `recording`, `browserProfile`,
`tabs` (parked only: `[{url,title,active}]`), `handoff` (summary or null). `proxy` must no longer leak credentials
(mask userinfo).

### 1.3 Activity
`sessionService.touch(id, source)`. Sources: (a) CDP commands from clients: a passive `data` tap on the client socket
of the CDP WS proxy with a small streaming frame parser (text frames, unmasking, fragmentation; unparsable or
compressed = activity); a command counts unless its `method` is in `IDLE_IGNORED_CDP_METHODS` (default
`Page.screencastFrameAck,Input.dispatchMouseEvent:mouseMoved,Target.getTargets,Browser.getVersion,Target.setDiscoverTargets,Page.startScreencast,Page.stopScreencast,Page.enable,Runtime.enable`;
`Method:type` matches `params.type`); (b) cast socket input other than mouse move; (c) `POST /v1/sessions/:id/touch`;
(d) mutating session-scoped REST calls (timeline post, handoff, capture). Passive GETs, `/context`, `live-details`,
request interception and open sockets never count.

### 1.4 Reaper
Tick `SESSION_REAPER_INTERVAL_MS=10000`. Live session expires when `idleTimeout > 0 && now - lastActivityAt >=
idleTimeout`, or `timeout > 0 && now - createdAt >= timeout`. Action = `onExpire`; a session that cannot be parked
(selenium) is released. Exempt from idle: `keepAlive`, a waiting handoff, a running background job. `expiresAt` is the
earliest of the two deadlines.

### 1.5 Queue and preemption
`POST /v1/sessions` and `/resume` with `queueTimeout > 0` wait FIFO for a slot (and for memory, see 1.8). The waiter is
dropped when the HTTP request closes. On timeout or `queueTimeout = 0`: `429 { code: "pool_full" | "low_memory",
pool: { max, live, queued } }` + `Retry-After`. Preemption: while a user request waits, the least recently active live
session with `onExpire = park`, not exempt (1.4), idle >= `SESSION_PREEMPT_IDLE_MS` (default 0 = off; production
120000) is parked with reason `preempted`. Background jobs (1.9) never preempt and never queue ahead of users.

### 1.6 Park and resume
- `POST /v1/sessions/:id/park { name?, reason? }` -> parked SessionDetails. 409 `not_live`, 409 `not_parkable`
  (selenium).
- `POST /v1/sessions/:id/resume { queueTimeout? }` -> live SessionDetails, same id. Idempotent on a live session.
  409 `profile_in_use` when its saved browser is held by another session.
- `POST /v1/sessions/:id/release` on a parked session discards it.
- `PATCH /v1/sessions/:id { name?, labels?, idleTimeout?, timeout?, onExpire?, keepAlive? }` (live or parked).
- `GET /v1/sessions/:id/thumbnail` (JPEG; live: fresh capture cached 5 s; parked: stored at park time).
- `GET /v1/sessions` keeps its current content and order; parked sessions are included only with
  `?include=parked` (the current UI would mislabel them). `GET /v1/sessions/:id` knows parked sessions.
- Park captures: tabs (url, title, active, scroll), all cookies via `Storage.getCookies`, sessionStorage per open
  origin, a thumbnail, and the launch identity (generated fingerprint, userAgent, dimensions, effective timezone,
  upstream proxy URL or egress name, deviceConfig, blockAds, extensions, userPreferences, credentials options,
  browserProfile). Then pre-end hooks (1.9), graceful `browser.close()` with wait for exit, slot -> free.
- Profile dir: a throwaway profile is moved to `<data>/parked/<id>/profile` and reused in place on resume (cache
  directories pruned; Singleton* files removed); a saved browser profile stays where it is and its lock is released.
- Resume: slot (queue aware), same identity, launch on the kept profile, inject cookies only (session cookies always;
  for a saved browser used by someone else since the park, inject nothing), reopen tabs in order, restore the active
  tab and scroll. localStorage is not re-injected (the profile has it).
- Parked meta: `<data>/parked/<id>/meta.json` (enveloped). Loaded at startup. Limits `PARKED_TTL_MS=604800000`,
  `PARKED_MAX=20` (oldest unnamed first); expiry = discard with `releaseReason: parked_expired`.
- Sockets and session-scoped routes of a parked session answer 409 `session_parked`; there is NO auto-resume on
  socket connect (an open viewer would un-park it). Routes given an id that is not live never fall back to another
  session (fix `/context`, `live-details`, capture).
- Shutdown: puppeteer `handleSIGTERM/SIGINT/SIGHUP: false`; a `preClose` hook parks every parkable live session
  (reason `shutdown`) within `SHUTDOWN_PARK_TIMEOUT_MS=20000`, releases the rest. Compose gets
  `stop_grace_period: 40s`.

### 1.7 Fixes folded in
`POST /v1/sessions/release` with `{sessionId}` must release only that one (body parser nulls `/release` bodies:
verify, fix); `isRunning()` truthfulness; rrweb injection off unless `RRWEB_RECORDING=true`.

### 1.8 Pool status and memory guard
`GET /v1/pool` -> `{ maxSessions, live, free, parked, queued, queue: [{position, kind, client, waitingMs}],
slots: [{index, cdpPort, primary, state, sessionId, sessionName, pid, rssBytes, pages}],
memory: {totalBytes, availableBytes, limitBytes, chromeRssBytes, minFreeBytes, pressure},
limits: {...env values}, background: {running, max} }`. RSS = sum over the Chrome process tree from /proc.
Memory guard: `MIN_FREE_MEMORY_MB` (0 = off): start/resume is treated as "no slot" (`low_memory`) while cgroup or
MemAvailable headroom is below it.

### 1.9 Platform services (decorated on fastify, used by every other package)
- `sessionService.hooks`: `onStarted(session)`, `onEnding(session, {reason, park})` (awaited, 10 s cap each, browser
  still up), `onEnded(session)`, `onParked`, `onResumed`.
- `events`: in-process bus + `GET /v1/events` (SSE, heartbeat 25 s, `?types=&sessionId=`). Types: `session.*`,
  `pool.queue`, `handoff.*`, `cookieset.*`, `timeline.entry`, `watcher.run`, `notification`.
- `notifier.send({event, severity, title, message, url?, sessionId?, data?})`: POST JSON to `NOTIFY_WEBHOOK_URL` when
  set (5 s timeout, 2 retries), keeps the last 200 in `notifications.jsonl`, `GET /v1/notifications`. Links use
  `STEEL_VIEWER_URL` (`<viewer>/?session=<id>`).
- `audit.log(event, {client, subject, sessionId, detail})` -> monthly JSONL, `GET /v1/audit?limit=&before=&event=&subject=`,
  `AUDIT_RETENTION_DAYS=180`.
- `metrics`: tiny registry (counter, gauge with labels) + `GET /metrics` (Prometheus text). Session, pool, queue,
  memory series in PR A; other packages register theirs.
- `store`: helpers for enveloped JSON, JSONL append, dir retention sweep.
- `jobs.run(kind, opts, fn)`: background session (own slot, `labels.background = kind`), max
  `BACKGROUND_MAX_SESSIONS=1`, never takes the last free slot, skipped when users are queued, hard timeout.
- `egress`: `EGRESS_PROFILES` JSON `{name: {proxyUrl, label}}`, built-in `direct`, `DEFAULT_EGRESS=direct`;
  `GET /v1/egress` -> `{default, profiles: [{name, label, type, healthy, publicIp, country, checkedAt}]}` (never the
  URL); health = fetch `https://www.cloudflare.com/cdn-cgi/trace` through the proxy, cached 10 min. `startSession`
  resolves `egress` to the upstream proxy URL before `proxyFactory`.
- Files: per-session directory `<data>/files/<sessionId>/`, download path set per session, no wipe by slot 0, file
  routes honor `:sessionId`, kept `FILES_RETENTION_HOURS=72` after release, `GET /v1/files?sessionId=`.

### 2. Logins (PR B): cookie library v2

- Stored set adds (all optional, v1 files stay readable; `save()` must preserve them, `summarize()` whitelists):
  `check {url, loggedInSelector?, loggedOutSelector?, loggedOutUrlPattern?, textIncludes?, intervalHours=24, enabled}`,
  `health {lastCheckAt, lastOkAt, lastResult {ok, reason, finalUrl, durationMs}, consecutiveFailures}`, `authCookies`,
  `writeBack` (default true), `previous {cookies, localStorage, updatedAt}`, `fingerprint` bundle
  `{fingerprint, userAgent, dimensions, timezone, locale}`, `pinFingerprint` (default true), `egress`, `acl {clients}`,
  `lastUsedAt`, `useCount`.
- Summary adds: `health.status` (`ok|expiring|expired|failing|unknown`), `authExpiresAt` (earliest expiry among
  `authCookies`, else among httpOnly persistent cookies, else all), `check`, `writeBack`, `egress`, `pinFingerprint`,
  `hasFingerprint`, `acl`, `lastUsedAt`, `useCount`, `hasPrevious`.
- Routes: `PATCH /v1/cookie-library/:name` (settings), `POST .../:name/check` (run now, 409 `no_check`),
  `POST .../:name/restore-previous`. Capture also stores the session's fingerprint bundle when the set has none.
- Session start with `cookieSets`: ACL (403 `cookie_set_denied`; `ui` always allowed; glob patterns on the client
  string), record the sets on the session, bump usage, audit `cookieset.loaded`. Identity: explicit body fields win,
  then a saved browser's fingerprint, then the first set with a pinned fingerprint. Egress: body, then first set with
  one, then default.
- Write-back in `onEnding` (release and park): for each loaded set with `writeBack`, merge browser cookies under the
  set's domains (update when value differs or expiry is later; add new; never delete), merge localStorage per origin;
  skip when more than half of the set's auth cookie keys are missing (looks logged out); keep `previous`; audit.
- Checks: `jobs.run("cookie-check")` loads the set, opens `check.url`, waits for load + 2 s, evaluates conditions,
  writes health, refreshes cookies on success, notifies on ok->failing, failing->ok and once per expiry window
  (`COOKIE_EXPIRY_WARN_DAYS=3`). Scheduler every 10 min inside `COOKIE_CHECK_WINDOW` (empty = any time).
- Audit events: `cookieset.loaded|read|captured|imported|updated|deleted|writeback|restored|denied|check`.

### 3. Agents (PR C): handoff, timeline, recording

- Handoff: `POST /v1/sessions/:id/handoff {reason, instructions?, doneWhen? {urlMatches?, urlNotMatches?, selector?,
  selectorGone?}, timeoutMs=900000 (max 3600000), notify=true}`; `GET .../handoff?wait=<s, max 50>` (long poll);
  `POST .../handoff/done {note?}`; `POST .../handoff/cancel {note?}`; `GET /v1/handoffs?status=waiting`.
  Object `{id, sessionId, status waiting|done|declined|cancelled|expired, reason, instructions, doneWhen, requestedBy,
  requestedAt, expiresAt, resolvedAt, resolvedBy (client | "condition" | "timeout"), note, liveUrl}`. One waiting
  handoff per session; the server polls `doneWhen` every 2 s; parking a session with a waiting handoff is refused.
- Timeline: `POST /v1/sessions/:id/timeline {kind="action", tool, args?, status, error?, durationMs?, url?, title?,
  screenshot?: boolean}` (server stamps seq, at, client; captures a 480 px JPEG when asked); automatic entries for
  lifecycle, handoff, cookie sets and main-frame navigations (per-session listener on the slot's log emitter, detached
  at end/park); `GET .../timeline?after=&limit=` (live, parked, released); `GET .../timeline/:seq/screenshot`.
  JSONL + JPEG under `timeline/<id>/`, `TIMELINE_RETENTION_DAYS=7`, 2000 entries per session.
- Recording: CDP screencast frames (invisible to the page), not rrweb. `record: true` at creation or
  `POST .../recording/start|stop`; frames `recordings/<id>/<seq>.jpg` + `manifest.jsonl {seq, t, at, pageId, url}`;
  follows the active page; caps `RECORDING_FPS_MAX=2`, `RECORDING_MAX_WIDTH=1280`, `RECORDING_JPEG_QUALITY=60`,
  `RECORDING_MAX_MB_PER_SESSION=300`, `RECORDING_TOTAL_MAX_MB=4000`, `RECORDING_RETENTION_DAYS=7`.
  `GET .../recording`, `GET .../recording/frames?from=&to=&limit=`, `GET .../recording/frames/:seq`,
  `DELETE .../recording`, `GET /v1/recordings`. Needs a screencast source that is not bound to a WebSocket and keeps
  the frame timestamp (refactor of page-screencast.ts or a separate CDP session per recorded page).

### 4. Extras (PR D)

- Warm sessions: `GET /v1/warm`, `PUT /v1/warm/:name {browserProfile?, cookieSets?, egress?, startUrl?, extensions?,
  enabled, refreshMinutes?}`, `DELETE`, `POST /v1/warm/:name/restart`. A warm session is a normal session with
  `keepAlive`, `name`, `labels.warm`, a deterministic id (uuid5 of the name), started at boot and restarted when it
  ends; at most `maxSessions - 1`. `GET /v1/sessions/by-name/:name`.
- Extract: `POST /v1/extract {url? | sessionId?, schema, prompt?, cookieSets?, egress?, waitFor?, queueTimeout?,
  includeMarkdown?}` -> `{data, url, title, model, usage, markdown?}`. Page text through the existing scrape helpers
  (extract them from the controller), LLM = OpenAI-compatible `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL=spark`; try
  `response_format: json_schema`, fall back to prompt-only JSON; validate with ajv, one repair retry; 502 `llm_failed`.
- Watchers: CRUD `/v1/watchers`, `POST /v1/watchers/:id/run`, `GET /v1/watchers/:id/history`. Watcher `{id, name, url,
  cookieSets?, egress?, intervalMinutes>=5, activeHours?, waitFor?, extract {selector?, attribute?, regex?, fullText?,
  llm? {schema, prompt}}, condition {type changed|contains|not_contains|matches|lt|gt|eq, value?}, notify {cooldownMinutes,
  onErrorAfter}, enabled, state {...}, history (last 50)}`. Runs as `jobs.run("watcher")`, postponed when the pool is busy.
- Extensions: library dir `<data>/extensions/<name>/` (unpacked), `GET /v1/extensions`, `POST /v1/extensions`
  (zip upload or `{url}` of a CRX/zip), `DELETE /v1/extensions/:name`; `extensions: [names]` on a session resolves
  there first, then the bundled ones.
- Upstream sync: fork workflow `upstream-sync.yml` (weekly + manual): merge steel-dev/steel-browser main into branch
  `upstream-sync`, open or update a PR, CI runs. Homelab workflow `steel-pin-bump.yml` (daily + manual): when fork
  main moved, open a PR that bumps both pins in `vps/mcp-steel/compose.yaml`.

### 5. MCP wrapper (homelab vps/mcp-steel)

- Sends `X-Steel-Client: mcp:<email>` and labels `mcp.session`, `mcp.owner` on every session it creates; default
  session key derives from the caller's email plus the MCP client name when available.
- The wrapper's own reaper stops releasing sessions: Steel's idle timeout parks them. On a tool call for a parked
  session the wrapper resumes it; on a missing one it says so. `browser_list_sessions` adds parked sessions and pool
  status. Session creation and resume use `queueTimeout=45000` (the chat client cuts tool calls near 60 s) and answer
  "all browsers busy, position N, retry" on 429.
- After each `browser_*` call: fire-and-forget timeline post (args redacted: typed text into password fields).
- New tools (each with exactly one of readOnlyHint/destructiveHint, catalog regenerated, MUST_ASK updated):
  `browser_park_session`, `browser_resume_session`, `browser_request_human` (creates the handoff and waits up to 50 s;
  returns `waiting` with the live URL so the agent calls `browser_wait_human` again, or tells the user),
  `browser_wait_human`, `browser_check_cookie_set`, `web_extract`, `watch_page`, `list_watches`, `delete_watch`.
  `browser_navigate` gains `egress`, `record`, `name`.
- Compose: new env, `steel-data` volume, `stop_grace_period`, Traefik header middleware, both pins bumped, notifier
  webhook to the VPS Home Assistant (webhook id from 1Password), LiteLLM key `steel`, `EGRESS_PROFILES` with `home` =
  proxy on spark1 (10.99.0.3 over WireGuard, new role in `dgx/ansible`, auth + private-range deny).

### 6. Harness panel (vertex-harness)

Logic now: pick the session whose labels match the agent's `args.profile ?? args.session_id` (else the caller's
default), dial `/v1/sessions/<id>/cdp` instead of the root socket, ignore parked sessions, stop the retry storm, stop
polling `/state` when the tab is closed. Visual parts (switcher, handoff banner, timeline, parked list) wait for the
design pick.

### 7. Work packages and file ownership (to keep parallel work mergeable)

- A (one implementer, first): `services/session.service.ts`, `browser-pool.service.ts`, `modules/sessions/*`,
  `cdp.service.ts` touch points, `env.ts`, `steel-browser-plugin.ts`, `routes.ts`, new `services/platform/*`
  (events, notifier, audit, metrics, store, jobs, egress, activity parser), `modules/platform/*` routes, files fix.
- B: `services/cookie-library.service.ts`, `modules/cookie-library/*`, new `services/cookie-health.service.ts`.
- C: new `services/handoff|timeline|recording`, `modules/handoff|timeline|recording`, screencast refactor.
- D: new `services/warm|extract|watchers|extensions`, `modules/...`, scrape helper extraction, `.github/workflows`.
- B, C, D register through one line each in `routes.ts` / plugin file / `env.ts` and through hooks; they do not edit
  session.service.ts except via the hooks above (ask the lead if a hook is missing).

### 8. Already merged by the other thread (fork main ef515aa, homelab f2115fe): build on it, do not redo
- `browserProfile` (saved browsers) and `vpn: { provider: "nordvpn", country }` on POST /v1/sessions, `GET /v1/vpn`,
  `services/nordvpn.service.ts`, `NORDVPN_SERVICE_*` env, UI fields for both; MCP `profile` maps to `browserProfile`.
- Egress (1.9) must wrap this instead of duplicating it: `GET /v1/egress` lists `direct`, the `EGRESS_PROFILES`
  entries and, when NordVPN is configured, `nordvpn:<country>` choices; `egress`, `vpn` and `proxyUrl` are mutually
  exclusive on a request; the session records which one it used so park/resume and cookie set pins reproduce it.
