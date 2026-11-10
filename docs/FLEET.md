# Browser workers, pairing and measured egress

The fleet runs dedicated browser profiles on approved machines. It uses outbound
authenticated polling, so a worker exposes no CDP, WebDriver or inbound HTTP port.
The existing `/v1/sessions` API remains the local Chromium pool. Fleet sessions use
`/v1/fleet/sessions` and their capability-driven command API; a Firefox or Safari
worker does not pretend to implement CDP.

## Pair and operate a worker

An authenticated operator creates a ten-minute, one-use grant with
`POST /v1/fleet/pairings` and `{label,location,engines}`. The grant limits engines
and assigns a dedicated profile scope. Start `workers/worker.mjs` with:

| Variable | Meaning |
| --- | --- |
| `STEEL_WORKER_COORDINATOR` | HTTPS Steel origin, or explicitly configured private HTTP control network |
| `STEEL_WORKER_PAIRING_TOKEN` | One-use grant; only needed before the first successful registration |
| `STEEL_WORKER_STATE_DIR` | Dedicated state directory, default `~/.local/state/steel-worker` |
| `STEEL_WORKER_ENGINES` | Comma-separated `chromium,firefox,webkit,safari,android` subset approved by the grant |
| `STEEL_WORKER_HEADLESS` | `false` for a real desktop; Safari requires this |
| `STEEL_WORKER_CHROME_PATH` | Optional actual host Chrome executable |
| `STEEL_WORKER_CAPACITY` | Simultaneous dedicated browsers, default one; Safari/Android require one |
| `STEEL_WORKER_ANDROID_SERIAL` | Required exact approved Android device serial |

Install the pinned dependencies with `npm ci --prefix workers`; Playwright
Firefox/WebKit use `npm run install:browsers --prefix workers`. A Mac Chrome worker
can use its installed Chrome without downloading an emulated engine. State and
worker credentials are mode 0600; the grant is exchanged for a scoped worker token.
Do not point the state directory at an existing personal browser profile.

For a logged-in macOS desktop, stage the approved source and pinned dependencies,
then pass `{coordinator, pairingToken}` as JSON on stdin to
`node workers/install-macos.mjs`. The installer exchanges the one-use token,
persists mode-0600 worker credentials and installs only the current user's
`fr.robiche.steel-worker` LaunchAgent. Its launchd environment contains no token.
Later source updates can run the installer with only the same coordinator;
existing credentials and dedicated profiles remain in place. This installs a
capacity-one native Chrome worker and does not change Safari settings.

Create `{engine,location?,workerId?,egressPolicy?,checkpointId?,headless?}` at
`POST /v1/fleet/sessions`. The result contains a session and a durable launch
command. Poll its command result, then acquire control using
`POST /v1/sessions/:id/control/acquire`. Every later command carries the lease in
`X-Steel-Control` and an idempotency key:

```json
{"kind":"goto","payload":{"url":"https://example.org"},"idempotencyKey":"open-example-v1"}
```

Submit to `/v1/fleet/sessions/:id/commands`; get the result from
`/v1/fleet/sessions/:id/commands/:commandId`. Supported commands are `goto`,
`click`, `fill`, `press`, `snapshot`, `screenshot`, `evaluate`, `cookies`,
`checkpoint`, and `close`. Unsupported engine capabilities return explicit errors.
Worker summaries disclose installed/observed versions and actual device metadata.
Graphics remain `unknown` until measured; headed mode alone is not proof of a GPU.

## Failure, control transfer and draining

Only one command per session is dispatched at a time. Placement is sticky;
disconnect never silently selects another location. Commands already claimed by
a lost worker or coordinator restart become **uncertain**, with no automatic
replay. An operator reconciles known outcomes at the command's `/reconcile` route.
Changing the control lease fences queued commands; an in-flight command becomes
uncertain and its dedicated browser is closed on the next worker poll. Polling
is normally once per second; actions already submitted to a website cannot be
retracted. After a prolonged coordinator outage the worker closes its browsers.

`POST /v1/fleet/workers/:id/drain` blocks new placements while existing sessions
continue. `/resume` admits work again; `/revoke` invalidates the token and fences
the worker. Reconnecting browsers after service restarts requires presence
reconciliation, and uncertain mutations still require an explicit decision.

The `checkpoint` command saves **portable web state** (cookies, localStorage,
sessionStorage and tabs). Launching a copy on a compatible worker uses the saved
state; it does not migrate a live process, complete a partially executed action,
preserve every native browser database, or undo a website's server-side changes.
Safari's current portable capture covers its current automation window. Its
isolated automation mode is distinct from a configurable Chrome profile.

## Strict egress

`egressPolicy: "strict"` is admitted only on a worker with the enforced Linux
boundary. `workers/strict-entrypoint.sh` runs in that worker container's own
network namespace: OUTPUT permits only the exact proxy TCP endpoint, coordinator
TCP endpoint, loopback TCP and established responses. It drops DNS/other UDP and
IPv6, writes a root-owned boundary attestation, then runs the browser as UID 1000
with no capabilities and no new privileges. It never changes host firewall rules.
The gateway requires one explicit upstream and has no direct fallback. The
ordinary local pool rejects strict requests when it lacks this boundary.

`workers/test-strict.sh <candidate-image>` tests the actual Chromium against owned
fixtures: direct TCP, DNS UDP and IPv6 are blocked, the proxy route succeeds,
dropping that proxy fails navigation, and the direct target receives no request.
The exact production-image workflow runs this check before publishing the image.

## Browser-origin observations

`POST /v1/sessions/:id/egress-diagnostics` creates a temporary diagnostic page
inside the actual session. The owned collector observes HTTP, WebSocket and
dedicated-worker requests and a bounded allowlist of browser identity headers.
Different HTTP versus WebSocket/worker public IPs are reported as failures.
Cookies, authorization and arbitrary collector headers are not included.

`STEEL_DIAGNOSTICS_COLLECTOR` selects the owned HTTP/WebSocket collector. Optional
`STEEL_DIAGNOSTICS_IPV6_COLLECTOR` must be an IPv6-only owned endpoint; absence is
reported as untested. `STEEL_DIAGNOSTICS_STUN_URL` selects owned STUN; no
server-reflexive response is **untested**, not evidence that WebRTC cannot leak.
Observed reflexive addresses are compared with the browser's HTTP exit.

`STEEL_DNS_DIAGNOSTICS_URL` and `STEEL_DNS_DIAGNOSTICS_TOKEN` select the private API
of the owned authoritative collector. A registered random hostname is resolved
by the browser; the report includes actual resolver source addresses and query
types from the authoritative server. Resolver addresses are DNS-route evidence,
not the browser's public HTTP address. The nonce's TLS connection can fail while
DNS measurement succeeds; TLS validation is never disabled. Missing/unavailable
collectors and unobserved probes remain explicit in the report.

## Exact image promotion

`build-docker.yml` builds the API, UI and worker candidates once. It tests the
installed API Chromium, the HTTP/2 empty-reason-phrase regression, real identity
and compatibility fixtures, a durable reviewed procedure with agent self-approval
denial and a verified screenshot receipt, all three Playwright worker engines, the strict
network boundary and built UI assets. Only those tested image IDs are published.
The release artifact records source revision, workflow run, actual Chromium
version and immutable digests. Homelab's pin workflow requires a successful run
for current main and validates that manifest before changing deployment pins.

Hardware acceptance is separate from code availability. A dedicated native
Chrome profile on the existing Mac mini passed input, screenshot and actual
Apple M4 graphics checks. The owner approved Safari's **Allow remote automation**
setting, but macOS requires unavailable local administrator authentication; the
owner explicitly skipped Safari validation. The adapter remains unvalidated on
that hardware. No real Android
device is available, so Android physical-device acceptance remains pending.
