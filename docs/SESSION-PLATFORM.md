# Session platform operator guide

PR #7 adds session expiry and parking, reusable login maintenance, human handoff,
activity and recording, browser jobs and operator tools. The source changes and
local tests do not establish that a production deployment is current. See the
implementation and deployment checklist in [PLANNED-FEATURES.md](PLANNED-FEATURES.md).
The API's generated contract is available at `/documentation` and in
[`api/openapi/schemas.json`](../api/openapi/schemas.json).

## Configure the runtime

[`api/.env.example`](../api/.env.example) contains every feature setting with code
defaults, except the annotated `CDP_REDIRECT_PORT=9223` bundled-nginx override
(the standalone code default is 9222). Durations ending in `_MS`, and API `timeout`, `idleTimeout` and
`queueTimeout`, are milliseconds. API timestamps use ISO 8601. Code defaults keep
lifetime expiry, idle expiry, preemption and the memory guard disabled.

A useful four-browser deployment starts with:

```dotenv
MAX_SESSIONS=4
STEEL_DATA_DIR=/data/steel
BROWSER_PROFILES_DIR=/data/browser-profiles
COOKIE_LIBRARY_DIR=/data/cookie-library
SESSION_IDLE_TIMEOUT_MS=600000
SESSION_EXPIRE_ACTION=park
SESSION_PREEMPT_IDLE_MS=120000
MIN_FREE_MEMORY_MB=512
BACKGROUND_MAX_SESSIONS=1
STEEL_VIEWER_URL=https://steel.example.com
```

Provide `STEEL_DATA_KEY` and `COOKIE_LIBRARY_KEY` through the deployment's secret
bindings. Using the same key is supported. Mount persistent volumes for the three
paths above, retain the existing browser-profile and cookie-library volumes, give
Chrome sufficient shared memory, and set a container stop grace of at least 40
seconds. The server allows 35 seconds for shutdown; `SHUTDOWN_PARK_TIMEOUT_MS`
(default 20 seconds) bounds capture before browser teardown.

`STEEL_DATA_DIR` holds parked metadata and profiles, session downloads, timelines,
recordings, audit history, watcher definitions/history, warm-session definitions,
extensions and notifications. Managed JSON/JSONL uses AES-256-GCM when
`STEEL_DATA_KEY`, or its fallback `COOKIE_LIBRARY_KEY`, is set. Cookie-library
files use `COOKIE_LIBRARY_KEY`. Saved-browser cookie sidecars use the data-key
fallback and can read legacy plaintext files, upgrading them on the next write.
Raw Chromium profiles, downloads and JPEG images are ordinary files protected by
the volume's access controls; the JSON envelope does not encrypt those files.
Keep the configured keys across redeployments so persisted data remains readable.

Requests may identify a caller with `X-Steel-Client`, at most 128 characters, for
example `mcp:person@example.com`, `harness:person`, or `ui`. Omission means
`anonymous`. This is attribution and cookie-set policy, not authentication. Keep
the API behind the existing authentication/network boundary. The public viewer's
reverse proxy should replace this header with `ui`; MCP supplies its own caller
identity on the internal lane.

## Session lifetime, queue and parking

Create a session with optional policy and identity:

```http
POST /v1/sessions
X-Steel-Client: mcp:person@example.com
Content-Type: application/json

{
  "name": "Research",
  "labels": {"project": "example"},
  "idleTimeout": 600000,
  "timeout": 3600000,
  "onExpire": "park",
  "queueTimeout": 45000,
  "cookieSets": ["work"],
  "cookieSetWriteBack": true,
  "egress": "direct",
  "record": false
}
```

`name` is at most 80 characters; `labels` accepts up to 20 string entries.
`timeout: 0` disables the maximum lifetime and `idleTimeout: 0` disables idle
expiry. `keepAlive: true` exempts a session from idle expiry, but does not exempt
it from its maximum lifetime. Waiting human handoffs and running server jobs are
also idle exemptions. `onExpire` is `park` by default or `release`; Selenium
sessions cannot be parked and are released when they expire.

Activity comes from client CDP commands, viewer input other than mouse movement,
explicit touches, and mutating session operations. The default
`IDLE_IGNORED_CDP_METHODS` excludes screencast acknowledgements, mouse movement,
target/version polling and viewer setup commands. Watching the viewer, leaving a
socket open, and polling session/context/live-details GETs do not keep a session
alive. `Method:type` in that setting filters `params.type`; compressed or
unparseable CDP traffic conservatively counts as activity.

| Operation | Behavior |
| --- | --- |
| `POST /v1/sessions/:id/touch` | Record activity and return the updated session |
| `PATCH /v1/sessions/:id` | Update `name`, `labels`, `timeout`, `idleTimeout`, `onExpire`, or `keepAlive`; works while live or parked |
| `POST /v1/sessions/:id/park` | Optional `{name, reason: "manual"}`; capture state, close Chrome, free its slot |
| `POST /v1/sessions/:id/resume` | Optional `{queueTimeout}`; restore the same ID; a live session is returned unchanged |
| `POST /v1/sessions/:id/release` | End a live session or permanently discard a parked one |
| `GET /v1/sessions?include=parked` | Include parked sessions; default listing preserves live/released compatibility |
| `GET /v1/sessions/:id/thumbnail` | Live JPEG cached for five seconds, or the saved parked thumbnail |
| `GET /v1/sessions/by-name/:name` | Find a named session |

Session details expose `lastActivityAt`, effective timeout values, `expiresAt`,
`onExpire`, `keepAlive`, `client`, `slot`, `cookieSets`, `egress`, `recording`,
`parkedAt`, `parkReason`, `resumeCount` and `releaseReason`. Parked details include
tab URL/title/active state. The deadline is the earliest applicable lifetime or
idle deadline. Parking pauses Chrome, not the original `createdAt`; change an
expired maximum lifetime with PATCH before resuming if it should be extended.

Parking saves open tabs, scroll, sessionStorage, current cookies, thumbnail,
launch identity and the Chrome profile. Resume keeps localStorage in the profile,
restores eligible HTTP(S)/blank tabs and their active tab, and does not auto-resume
when a viewer socket connects. Named saved-browser profiles stay in their own
location and can be used by another session while parked; stale snapshot state
must not overwrite a saved browser subsequently used by someone else. A profile
currently held by a live session returns `409 profile_in_use`.

Parked metadata is loaded on restart. `PARKED_TTL_MS` defaults to seven days;
zero disables TTL expiry. `PARKED_MAX` defaults to 20, pruning the oldest unnamed
sessions first when over capacity. Expiry discards the snapshot with reason
`parked_expired`. Graceful shutdown parks eligible live sessions and releases
those that cannot be parked. Browser crashes still trigger release.

Creation and resume wait FIFO when `queueTimeout > 0`. Disconnecting the HTTP
client removes its waiter. The timeout covers slot admission, not browser launch.
`SESSION_QUEUE_MAX_MS` caps the request and environment defaults. A full pool or
memory pressure returns `429` with `code: pool_full|low_memory`,
`pool: {max, live, queued}`, and `Retry-After: 1`; shutdown rejects queued work with
`503 shutting_down`. Selenium requires the primary slot and retains FIFO order.

Preemption is disabled at `SESSION_PREEMPT_IDLE_MS=0`. When enabled and a user is
waiting, an eligible least-recently-active session may be parked after that idle
threshold. Keep-alive sessions, handoffs and active jobs are exempt. Background
jobs never preempt or queue ahead of users and always leave one free slot.

## Pool, files, events and operations

`GET /v1/pool` returns live/free/parked/queued counts, waiter positions and kinds,
slot ownership/state, process information, memory headroom, configured limits and
background-job usage. Slot states are `free`, `starting`, `live`, `stopping`.
A slot becomes free only after Chrome exits and the primary idle browser has been
restored. Concurrent release requests share teardown. Failed cleanup quarantines
the slot instead of lending a possibly running browser to another session.

`MIN_FREE_MEMORY_MB` compares host `MemAvailable` and cgroup headroom before
admission. Zero disables the guard. Chrome RSS includes descendants of each
browser process. These values describe sampled process/container memory, not a
reservation guaranteeing the next page's memory usage.

Downloads/uploads are scoped to `<STEEL_DATA_DIR>/files/<sessionId>/` and retained
for `FILES_RETENTION_HOURS` (72 by default) after release. Use
`GET /v1/files?sessionId=:id` or `GET /v1/sessions/:id/files` to list files, and
`GET /v1/sessions/:id/files/:path` to download. The scoped routes also provide
multipart upload, HEAD, deletion and archive operations. No scoped request falls
back to another browser's files. The UI lists downloads for the selected session.

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/events?types=session.*,handoff.*&sessionId=:id` | SSE events with a 25-second heartbeat; both filters are optional |
| `GET /v1/notifications` | Latest 200 persisted notifications |
| `GET /v1/audit?limit=100&before=ISO&event=...&subject=...` | Monthly audit history, retained for `AUDIT_RETENTION_DAYS` (180 by default) |
| `GET /metrics` | Prometheus session, queue, memory, background and cookie-health metrics |

Configure `NOTIFY_WEBHOOK_URL` to receive JSON notifications containing event,
severity, title, message and optional session URL/data. Delivery has a five-second
timeout and two retries. `STEEL_VIEWER_URL` supplies links to the session viewer.
Notifications remain visible through the API even when no webhook is configured.

## Egress and saved logins

`egress`, `vpn` and `proxyUrl` are mutually exclusive explicit launch choices.
`direct` is built in; named proxies are configured as JSON:

```dotenv
DEFAULT_EGRESS=direct
EGRESS_PROFILES={"home":{"proxyUrl":"http://USER:PASSWORD@proxy.example:3128","label":"Home"}}
```

Keep the real value in a secret binding. HTTP, HTTPS and SOCKS proxy URLs are
supported. Existing NordVPN service credentials enable `nordvpn` and
`nordvpn:FR`-style choices; the existing `vpn` request remains supported.
`GET /v1/egress` returns names, labels, type, health, public IP, country and check
time, never the upstream credentials. Health probes use Cloudflare's trace
endpoint and are cached for ten minutes.

Existing cookie-library import/capture/list/read/delete endpoints remain.
Add maintenance settings with `PATCH /v1/cookie-library/:name`:

```json
{
  "check": {
    "url": "https://example.com/account",
    "loggedInSelector": "#account-menu",
    "loggedOutSelector": "form.login",
    "intervalHours": 24,
    "enabled": true
  },
  "authCookies": ["session"],
  "writeBack": true,
  "pinFingerprint": true,
  "egress": "home",
  "acl": {"clients": ["mcp:person@example.com", "harness:*"]}
}
```

Checks also support `loggedOutUrlPattern` (regular expression) and `textIncludes`.
`authCookies` accepts cookie names or complete cookie keys. The summary's
`authExpiresAt` uses selected auth cookies, otherwise persistent HttpOnly cookies,
otherwise all cookies. Summaries expose `health.status` as
`ok|expiring|expired|failing|unknown`, last check/result, use count, settings and
presence of a fingerprint/previous version without credential values.

`POST /v1/cookie-library/:name/check` runs a separate background browser check.
It returns `409 no_check` without configuration or `503 pool_busy` when capacity
is unavailable. The scheduler considers due checks every ten minutes.
`COOKIE_CHECK_WINDOW` is empty for any time, or a UTC interval such as
`23:00-02:00`; `COOKIE_EXPIRY_WARN_DAYS` defaults to 3. Notifications cover
passing-to-failing and failing-to-passing transitions and one warning per auth
cookie expiry. Successful checks can refresh credentials.

Session launch enforces cookie-set client patterns (`*` and `?`), with
`403 cookie_set_denied` for a denied caller. `ui` is always allowed. Fingerprint
precedence is explicit request fields, then an existing saved-browser identity,
then the first pinned cookie set. Egress precedence is an explicit request,
then the first cookie-set egress, then `DEFAULT_EGRESS`.

Puppeteer release and park write newer cookies/localStorage back under the set's
existing domains, unless the session's `cookieSetWriteBack` or set's `writeBack`
is false. Cookies are merged, not deleted. A snapshot missing more than half the
auth-cookie keys is skipped to avoid replacing a valid login with a logged-out
state. `POST /v1/cookie-library/:name/restore-previous` restores the prior version
or returns `409 no_previous`. Loading, reading, capture, import, changes, deletion,
write-back, restore, checks and denied access are audited.

## Human handoff, timeline and recording

Create a handoff with `POST /v1/sessions/:id/handoff`:

```json
{
  "reason": "Complete the sign-in challenge",
  "instructions": "Use the live viewer, then click Done.",
  "doneWhen": {"selector": "#account-menu"},
  "timeoutMs": 900000,
  "notify": true
}
```

Only one handoff may wait per session. `doneWhen` can combine `urlMatches`,
`urlNotMatches`, `selector` and `selectorGone`, checked every two seconds. A
handoff defaults to 15 minutes and accepts at most one hour. Waiting handoffs
suppress idle expiry and manual parking, but do not disable maximum lifetime.

`GET /v1/sessions/:id/handoff?wait=50` long-polls for up to 50 seconds; no handoff
returns 404. POST `/handoff/done` or `/handoff/cancel` with an optional `note` to
resolve it; cancel accepts `declined: true`. `GET /v1/handoffs?status=waiting`
lists waiting work. States are `waiting`, `done`, `declined`, `cancelled`, `expired`.
The UI presents instructions, the live link and Done/Cancel controls.

`POST /v1/sessions/:id/timeline` accepts `tool`, optional `kind`, `args`, `status`,
`error`, `durationMs`, `url`, `title` and `screenshot: true`. The server stamps
sequence/time/client, redacts credential-like arguments and can capture a 480-pixel
JPEG. Lifecycle, handoff, cookie-set and main-frame-navigation entries are also
recorded. Read with `GET .../timeline?after=0&limit=100` and fetch a screenshot at
`GET .../timeline/:seq/screenshot`. Live, parked and released histories are
readable. The cap is 2,000 entries per session and `TIMELINE_RETENTION_DAYS=7`.

Recording is opt-in with `record: true` at creation or
`POST /v1/sessions/:id/recording/start`; `/stop` stops it. This uses CDP screencast
JPEGs rather than rrweb injection and follows the active page. Read metadata at
`GET .../recording`, list frames at `GET .../recording/frames?from=0&to=60000&limit=500`,
and fetch JPEGs at `GET .../recording/frames/:seq`. Frame bounds are elapsed
milliseconds. `GET /v1/recordings` lists recordings; `DELETE .../recording` removes
one. Defaults are 2 FPS, 1280-pixel width, JPEG quality 60, 300 MB per session,
4000 MB total and seven-day retention. Reaching a storage cap stops recording;
delete old recordings or adjust the cap before restarting. The UI offers playback
beside the activity timeline. `RRWEB_RECORDING=false` remains independent.

## Warm browsers, extraction, watchers and extensions

Warm definitions are persisted and reconciled at startup. Use `GET /v1/warm`,
`PUT /v1/warm/:name`, `DELETE /v1/warm/:name`, and
`POST /v1/warm/:name/restart`. PUT accepts `browserProfile`, `cookieSets`, `egress`,
`startUrl`, `extensions`, `enabled`, and optional `refreshMinutes`. The session has
a stable UUID, its name, `keepAlive` and `labels.warm`. At most
`MAX_SESSIONS - 1` warm definitions may occupy browsers. User queues take priority.
The creator's client identity is persisted so cookie-set policies still apply.

`POST /v1/extract` accepts either a URL or an existing live `sessionId`, a JSON
`schema`, optional `prompt`, `cookieSets`, `egress`, `waitFor`, `queueTimeout` and
`includeMarkdown`. `waitFor` is a selector or milliseconds (at most 30 seconds).
The response is `{data, url, title, model, usage?, markdown?}`. For example:

```json
{
  "url": "https://example.com/catalog",
  "schema": {
    "type": "object",
    "properties": {"title": {"type": "string"}},
    "required": ["title"],
    "additionalProperties": false
  },
  "includeMarkdown": true,
  "queueTimeout": 45000
}
```

Set `LLM_BASE_URL` to an OpenAI-compatible base URL, optionally `LLM_API_KEY`, and
`LLM_MODEL` (default `spark`). Extraction uses readable page text, requests
structured JSON when supported, falls back to prompted JSON, validates against
the supplied schema and allows one repair retry. Failures return
`502 llm_failed`; missing LLM configuration must be resolved before use. The
request timeout defaults to 45 seconds and text is capped at 100,000 characters.
A local deterministic LLM fixture validates the contract; live provider access is
a separate deployment check.

New URL extraction and watcher jobs accept only HTTP(S) destinations without URL
credentials. They resolve and validate every intercepted HTTP request, including
redirects, subframes and subresources; loopback, private, link-local, metadata and
reserved addresses (including IPv4-mapped IPv6) return `400 blocked_target`.
Mixed public/private DNS answers are rejected. These job pages bypass service
workers and receive a document CSP that disables WebSocket connections and new
workers. Sites that require those features may provide incomplete content.
`EXTRAS_ALLOW_PRIVATE_NETWORKS=false` is the default; set it to `true` only when
these jobs must reach intranet services. The opt-in retains HTTP(S), credential,
WebSocket and worker restrictions. DNS checks do not pin the browser's connection
address; use an egress firewall when strict network isolation is required.

Extraction from an existing `sessionId` takes a read-only snapshot and validates
its captured URL. It does not reload that page or change its scripts, workers or
network behavior. Existing sessions, regular browsing, warm sessions and login
health checks keep their existing browser network contract; this job policy is
not a general browser sandbox.

Watchers use `GET/POST /v1/watchers`, `GET/PUT/PATCH/DELETE /v1/watchers/:id`,
`POST .../:id/run` and `GET .../:id/history`. A definition includes:

```json
{
  "name": "Stock notice",
  "url": "https://example.com/product",
  "intervalMinutes": 30,
  "activeHours": {"start": 8, "end": 22, "timezone": "Europe/Paris"},
  "extract": {"selector": "#stock"},
  "condition": {"type": "contains", "value": "Available"},
  "notify": {"cooldownMinutes": 60, "onErrorAfter": 3},
  "enabled": true
}
```

Intervals are at least five minutes. Extraction supports selector, attribute,
regex, full text or an LLM schema/prompt. Conditions are `changed`, `contains`,
`not_contains`, `matches`, `lt`, `gt`, `eq`. State and the last 50 runs persist;
a run is `ok`, `error` or `postponed`. Browser jobs postpone when capacity is busy
and do not take the final free slot. Watchers retain their creator's client
identity and reapply cookie-set access rules when each session starts.

`GET /v1/extensions` lists the library and bundled extensions. Install with
`POST /v1/extensions` using JSON `{name, url}` or multipart fields `name` and
`file`; ZIP and CRX2/CRX3 are supported. The default download/upload cap is 25 MB,
expanded archives are limited to 100 MB and 2,048 files, and ZIP64/encrypted or
unsafe archive entries are rejected. Delete with `DELETE /v1/extensions/:name`.
`extensions: ["name"]` on session creation resolves installed library names
before bundled names.

## MCP, harness and release verification

The companion changes live in `homelab/vps/mcp-steel` and `vertex-harness`.
MCP session creation/resume waits up to 45 seconds, supplies caller identity and
ownership labels, resumes parked sessions on tool use and reports missing ones.
Steel owns idle parking; the wrapper no longer destroys sessions with a second
idle reaper. New tools cover park/resume, request/wait for a human, cookie checks,
structured extraction and watcher CRUD. Browser tool activity is recorded in the
timeline with sensitive input redacted. The harness uses matching ownership
labels and the selected session's CDP route, excludes parked targets, and stops
state polling when closed.

The UI includes session controls/deadlines, pool and memory status, cookie health,
handoff, timeline, downloads, recordings, watchers, warm definitions, extensions,
egress, extraction, notifications and audit. The selected design and actual
visual/deployment completion are tracked in the roadmap checklist.

The fork's `upstream-sync.yml` runs weekly and manually, merging upstream into a
review branch, validating it and creating/updating a PR. Homelab's
`steel-pin-bump.yml` opens a PR when fork main advances, updating both API and UI
pins. The checked-in deployment pins and live deployment status remain separate
from the current feature branch.

Before declaring a release deployed, record the exact pushed commit and verify
API/UI builds and tests, generated OpenAPI/client types, live queue handoff,
expiry/park/resume across restart, login maintenance, scoped files, handoff,
recording/playback, warm/watcher scheduling, and MCP/harness session selection.
Verify the real webhook, home proxy and LLM model independently of local fixtures.
Preserve profile/cookie/data volumes during rollout and rollback; changing an
image pin must not recreate those volumes or change the stored encryption keys.
