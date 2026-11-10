# Browser work platform

## Verified callers and control

Configure `STEEL_AUTH_KEYS` with a JSON map of strong bearer tokens to `{id,role}` (`agent` or `operator`). Proxy deployments may use `X-Steel-Authenticated-User` and `X-Steel-Proxy-Secret`. The normal `STEEL_TRUST_PROXY_SECRET` always grants the **agent** role. A distinct `STEEL_OPERATOR_PROXY_SECRET`, kept only by the verified human gateway, grants operator status only for IDs listed in `STEEL_OPERATORS`. Human and agent proof can use the same canonical email without granting the agent permission to approve its own review. `X-Steel-Client` is attribution, never authentication. Without configured credentials, Steel runs as a local, unauthenticated single-user operator; verified-client budgets cannot be enabled in that mode.

A browser resource retains its creator's read ACL. Acquiring or transferring control creates an expiring lease with a monotonic generation. Takeover changes the controller, preserving the resource owner's observation rights. Tokens are random, remain stable across renewals, are never persisted, and stop working after transfer, expiry, release or server restart.

- `GET /v1/sessions/:id/control` returns `{lease}`.
- `POST .../control/acquire` with `{mode:"agent"|"human",ttlMs?}` returns `{lease,token}`.
- Send `X-Steel-Control: <token>` for browser mutations.
- `POST .../control/renew` with `{ttlMs?}` renews the same token; `.../release` relinquishes it.
- `POST .../control/transfer` explicitly transfers to a mode; an operator may override an existing controller or specify `ownerId`.
- `POST .../control/ticket` with `{channel:"cdp"|"cast"}` creates a one-use 30-second WebSocket ticket. `{channel:"cast",observer:true}` requires read access and grants no input rights.

CDP accepts authenticated headers plus the control token, or `?controlTicket=`. Every CDP frame and viewer input checks the current generation. Read-only CDP supports a deliberately small protocol allowlist; Playwright should acquire control before connecting because its connection setup mutates browser targets. Human takeover interrupts session commands and pauses task runs. A command already delivered to a remote website cannot be recalled.

The scoped viewer accepts a same-origin parent message `{type:"steel-control",sessionId,token}` and obtains a fresh ticket for each socket. `token:null` returns to observation. Keep tokens in tab memory, never local storage. The former raw DevTools redirect now points to an authenticated scoped viewer. Controlled inspection uses `GET /v1/sessions/:id/devtools?controlTicket=<CDP ticket>&pageId=<optional target>`. Steel serves Chrome's frontend assets through the authenticated API and binds its socket to that session's target; it never exposes a raw Chrome port. Opening DevTools requires already-held control and does not acquire it. Reopening needs a fresh one-use ticket.

Existing browser profiles, warm records and watchers created before verified ownership are operator-only until deliberately assigned or recreated. `PUT /v1/browser-profiles/:name/owner` assigns an existing inactive saved browser to `{ownerId}`. Legacy attribution strings are never silently promoted to authority. Agents cannot supply raw profile paths, arbitrary Chrome arguments or runtime hooks.

## Commands and durable runs

Each live session has its own existing commands engine, reference table, idempotency journal and file root. Use `/v1/sessions/:id/commands` and its schema/execution/cancellation routes for any pool slot. Parking, release and takeover discard that engine and cancel pending input. Configured site interaction delays apply immediately before each mutation only when the current page matches the selected origin profile.

`POST /v1/runs` accepts either an existing `sessionId` or validated public `sessionOptions`, plus 1–500 steps `{id,kind,input,retry?}`. Existing human control can be explicitly delegated with `X-Steel-Control`; the old token is fenced. `GET /v1/runs` and `GET /v1/runs/:id` expose caller-owned progress. `POST .../cancel` stops work; `POST .../resume` reenters a waiting step.

The built-in `commands` step reuses the session engine. A step is journaled as running before execution. Failed or interrupted external mutations become `uncertain`, never blindly replayed. Resuming them requires `{resolution:{stepId,outcome:"applied"|"not_applied",evidence}}`. Marking an effect as applied advances the cursor; marking it not applied explicitly permits another attempt. Read-only observations and extension kinds declared safe can retry within their configured bounds. Idempotency keys compare the entire validated task definition, session options and metadata.

Extension kinds register validation, replay safety and an executor. `beforeStep` supports exact approval gates. Registered executors receive an abort signal, fenced control token and scoped `execute` function; they must recheck control immediately before any direct external mutation. Cancellation is bounded even when an executor ignores its abort signal, and its later `execute` calls are rejected. Private-capture sessions retain command status/effects but omit arbitrary browser output before durable persistence.

Startup first loads/classifies runs with `initialize(false)`; the application invokes `startRecovered()` after procedure, vault and other executor services are ready. This avoids executing recovered work against unloaded configuration.

## Checkpoints and diagnosis

`POST /v1/sessions/:id/checkpoints` with `{name,retentionDays?}` closes Chrome safely, captures profile/tab/cookie/sessionStorage state and resumes the original browser. Its old control token is fenced during shutdown. Retention is 1–365 days, default 30. The manifest hashes every regular profile file; links and special files are refused. Metadata uses the configured encrypted store; profile bytes use the same protected on-disk storage model as parked browsers.

`GET /v1/checkpoints`, `GET/DELETE /v1/checkpoints/:id`, and `POST .../:id/branch` list, remove or restore independent copies. A branch verifies the manifest and gets a new session ID and profile directory. It does not write back to shared cookie-library records. Checkpoints restore browser state; they do not reverse effects already submitted to remote websites.

`POST /v1/sessions/:id/diagnose` runs bounded read-only CDP/renderer probes and records fixed, sanitized evidence. DNS from the API host is reported separately as `host_dns`. For browser HTTP, proxy and authoritative DNS evidence, first explicitly run `POST /v1/sessions/:id/egress-diagnostics`; diagnosis consumes its saved result without opening tabs or issuing browser-origin network probes. It accepts only measurements from the exact current browser launch and the preceding two minutes, including an `observedAt` timestamp. Restarted, resumed, missing or stale measurements remain `untested` and propose a fresh probe.

Chrome's specific proxy connection/tunnel and name-resolution failures are distinguished from a collector outage. An HTTP failure alone does not establish a proxy failure, and successful HTTP does not establish the DNS resolver path or prove that all channels obey a proxy. The downloadable diagnosis includes fixed evidence and confidence, never the collector's addresses, raw headers, URLs, exception messages or credentials. Authentication and application classifications retain explicit marker limitations. `GET /v1/diagnostics/:id/bundle` downloads the owner-restricted JSON report. Recovery suggestions are never executed automatically.

## Fair admission and budgets

Operators configure `GET/PUT /v1/budgets` with `{defaultMaxConcurrent,clients:{id:{maxConcurrent,weight}},sites:{"https://exact.origin":{maxConcurrent}}}`. Policies are persisted and may be changed while all browsers are parked. Verified client IDs determine limits and weighted fair queue order; caller-supplied labels cannot change them. Capacity is reserved synchronously with pool admission, including competing foreground/background launches.

Set `siteScope` when launching a site workload to reserve that site's browser capacity before Chrome starts. Attached browser targets also claim configured origins before intercepted requests proceed; site reservations last until the browser is parked or released. This limits concurrent browser workloads, not HTTP request rates. Declaring the site is necessary for admission to account for the workload before initial navigation.

Queue exhaustion returns HTTP 429 with `Retry-After: 1` and a concrete `pool_full`, `low_memory`, `client_budget` or `site_budget` reason. Waiting clients retain their place while another client's quota is saturated. Cancelled requests leave the queue without consuming a slot. Pool telemetry hides other principals' session identities from agent callers.
