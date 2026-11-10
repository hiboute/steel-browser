# Several sessions at once (hiboute fork)

Stock Steel runs one Chrome and one session. This fork keeps a pool of
`MAX_SESSIONS` browsers (default `1`, which behaves like stock), one Chrome per
session, each on its own CDP port (`CDP_PORT_BASE`, `CDP_PORT_BASE + 1`, ...)
and its own profile directory.

| Env | Default | Meaning |
| --- | --- | --- |
| `MAX_SESSIONS` | `1` | Browsers in the pool, so sessions that can be live at once |
| `CDP_PORT_BASE` | `9222` | CDP port of slot 0; later slots take the next free ports |
| `CDP_RESERVED_PORTS` | `9223` | Comma-separated ports never given to a browser (9223 is the bundled nginx CDP proxy) |
| `SESSION_QUEUE_TIMEOUT_MS` | `0` | Default wait for a browser slot, in milliseconds; zero returns 429 immediately |
| `SESSION_QUEUE_MAX_MS` | `600000` | Maximum allowed request queue timeout; caps the environment default too |
| `SESSION_TIMEOUT_MS` | `0` | Default maximum lifetime; zero disables it |
| `SESSION_IDLE_TIMEOUT_MS` | `0` | Default idle timeout; zero disables it |
| `SESSION_EXPIRE_ACTION` | `park` | Park or release an expired session |
| `SESSION_PREEMPT_IDLE_MS` | `0` | Idle threshold for parking a session to serve queued work; zero disables it |
| `STEEL_DATA_DIR` | `./data` | Persistent state, parked profiles, downloads and history |
| `MIN_FREE_MEMORY_MB` | `0` | Minimum memory headroom before a new browser starts; zero disables it |
| `BACKGROUND_MAX_SESSIONS` | `1` | Concurrent background browser jobs, always leaving one free slot |
| `RRWEB_RECORDING` | `false` | Load the bundled rrweb recorder in headless Chrome |

Give the container enough shared memory (`shm_size`) and RAM for that many
Chromes (roughly 300 MB to 1 GB each, depending on the pages).

The extended runtime is documented in [Session platform operator guide](docs/SESSION-PLATFORM.md):
expiry and parking, login health and write-back, handoff, timeline and recordings,
egress, background jobs, extraction, watchers, warm browsers, extensions, files
and deployment settings. [PLANNED-FEATURES.md](docs/PLANNED-FEATURES.md) distinguishes
implemented work from deployment verification.

## API

- `POST /v1/sessions` takes a free slot. When all are taken it answers `429` by default.
  Pass `{"queueTimeout": 30000}` to wait up to 30 seconds in FIFO order. The timeout
  covers waiting for a slot, not browser launch. The request must remain connected.
  Timeout returns `429` with `code: "pool_full"`, `pool: {max, live, queued}` and
  `Retry-After: 1`. Disconnecting cancels the queued request; shutdown rejects it with
  `503` and `code: "shutting_down"`. A Selenium request waits for the primary slot;
  later requests remain behind it even if a secondary slot is free.
- `GET /v1/pool` returns `maxSessions`, `live`, `free`, `queued`, a FIFO `queue`
  (`position`, `sessionId`, `waitingMs`) and `slots` (`index`, `cdpPort`, `primary`,
  `state`, `sessionId`), plus parked counts, caller/kind metadata, process and memory
  statistics, configured limits and background usage. Slot states are `free`, `starting`, `live` and `stopping`.
  A session becomes live only after launch succeeds. Release keeps ownership through
  browser teardown and the primary idle relaunch. Failed cleanup leaves a slot
  `stopping` and unavailable until the service restarts. Concurrent releases share
  the same operation.
- The first slot is the primary browser: it keeps an idle browser between
  sessions, its session's `websocketUrl` stays `ws://host/`, and the unscoped
  endpoints (`/v1/scrape`, `/v1/screenshot`, `/v1/pdf`, the root CDP socket)
  use it. Other slots run Chrome only while a session holds them.
- Every session's `websocketUrl` also works as
  `ws://host/v1/sessions/<id>/cdp`; connect Puppeteer or Playwright there.
- `GET /v1/sessions` lists live sessions first (newest first), then released
  ones. `GET /v1/sessions/<id>`, `/context`, `/live-details` and
  `POST /v1/sessions/<id>/release` act on that session only;
  `POST /v1/sessions/release` with an empty body releases all of them. Supplying
  `{"sessionId": "<uuid>"}` releases only that session. Unknown IDs on scoped context,
  stream and live-details endpoints return 404.
- Per-session sockets: `/v1/sessions/<id>/{cast,logs,pageId,recording}`, or
  the unscoped paths with `?sessionId=<id>`. The live view page is
  `/v1/sessions/<id>/debug`.
- `POST /v1/sessions/<id>/park` frees its Chrome slot while retaining its state;
  `/resume` restores the same ID, and `/release` discards a parked session.
  `GET /v1/sessions?include=parked` includes parked sessions. `PATCH /v1/sessions/<id>`
  changes name/labels/expiry settings; `POST .../touch` records activity.
- Opt into maximum lifetime and idle expiry with `timeout` and `idleTimeout` on
  creation. The default expiry action is parking; `keepAlive` exempts idle expiry
  only. The viewer and read-only polling do not reset idle time.
- A session whose Chrome dies (crash, kill) is released automatically.

## Cookie library

Named, reusable logins: the cookies and localStorage of a session, saved under
a name and loaded into any new session.

| Env | Default | Meaning |
| --- | --- | --- |
| `COOKIE_LIBRARY_DIR` | `./cookie-library` | One JSON file per set; mount a volume here |
| `COOKIE_LIBRARY_KEY` | unset | When set, files are AES-256-GCM encrypted with a key derived from it |

- `POST /v1/cookie-library/<name>/capture` with `{ "sessionId", "domains"?: [...] }`
  saves a live session's cookies and localStorage (only those sites when
  `domains` is given, subdomains included).
- `PUT /v1/cookie-library/<name>` with `{ "cookies": [...], "localStorage"? }` imports a set.
- `GET /v1/cookie-library` lists sets without values; `GET /v1/cookie-library/<name>`
  returns one with values; `DELETE /v1/cookie-library/<name>` removes it.
- `POST /v1/sessions` with `"cookieSets": ["a", "b"]` starts the session with
  those sets merged in order (later wins), then `sessionContext` on top.
- The UI has a Cookie library page, a "Save cookies" button on live sessions,
  and a "Start logged in with" picker in the new-session dialog.

- `PATCH /v1/cookie-library/<name>` configures health checks, auth-cookie selection,
  write-back, fingerprint/egress pins and client access rules. `/check` runs a check;
  `/restore-previous` restores credentials from before the last write-back.
- Live Puppeteer sessions refresh their loaded sets on release or park, with domain
  filtering and a guard against replacing a login with a logged-out snapshot.
  Summaries expose health and expiry without cookie values. See the operator guide
  for scheduler windows, notifications and identity precedence.

The library holds live credentials: keep the API behind authentication.

## Profiles

A session without `persist` runs on a fresh profile directory that is deleted
on release, so nothing (cookies, storage, tabs) carries over to the next
session on the same browser. `persist: true` keeps one profile per slot.

## Saved browsers

`browserProfile: "<name>"` on `POST /v1/sessions` runs the session in a named
Chrome profile kept under `BROWSER_PROFILES_DIR` (default `./browser-profiles`;
mount a volume there). It is created on first use and keeps everything a real
browser keeps (cookies, storage, IndexedDB, device keys, history), plus
`steel-fingerprint.json`, the fingerprint it got on first use and reuses on
every start, so a site sees the same device each time. A cookie set only
copies cookies into a fresh browser, which some sites (Google) reject.

One session per saved browser at a time (409 otherwise); release frees it.
`GET /v1/browser-profiles` lists them (`inUseBy`), `DELETE
/v1/browser-profiles/<name>` deletes one that is not in use. The UI's Start
session dialog has a "Saved browser" field. `SessionService.lockProfile`,
`unlockProfile`, `profileOf` and `profileHolder` are the lock's only API.

## NordVPN

`vpn: { provider: "nordvpn", country?: "FR" }` on `POST /v1/sessions` routes
the session through a recommended NordVPN HTTPS proxy server (port 89) in
that country, using the service credentials in `NORDVPN_SERVICE_USER` /
`NORDVPN_SERVICE_PASS` (Nord Account > Set up NordVPN manually > Service
credentials). The session's `proxy` shows `nordvpn:<host>`, never the
credentials. `GET /v1/vpn` says whether it is set up; the UI shows a NordVPN
switch only then.
