# Browser identity and compatibility

These features measure consistency and browser compatibility. They do not promise that a site will accept automation or that automation is undetectable.

## Modes and persistent identity

A session accepts `compatibilityMode: "native" | "compatible" | "legacy"`, `identityProfile`, `siteProfile`, `mobileProfile`, `continuityPolicy: "warn" | "require-confirmation"`, `continuityToken`, and `frictionDetection`.

- **Native** disables fingerprint generation/injection and retains normal Chromium automation indicators. Steel's operational launch flags, container fonts, graphics backend, and network policy still apply; this does not mean a physical desktop.
- **Compatible** uses supported CDP UA/Client Hints, language, viewport and touch overrides. It does not patch JavaScript console, reflection, graphics APIs, or Worker constructors. Desktop presets currently describe the actual Linux Chromium runtime. Client Hints and UA versions follow the measured installed Chromium version.
- **Legacy** preserves the previous script/injector behavior for existing sessions. The inspector labels the legacy script unverified and reports any fallback injector. No migration silently changes a retained identity.

Requests without a mode retain legacy behavior. New identity profiles default to compatible mode. Explicit fields that conflict with a selected profile fail with a structured 409 instead of silently mixing identities. A saved browser or cookie set can have one identity binding. Imported cookies/storage and egress remain available in native mode, but importing them cannot reintroduce an old fingerprint or UA.

Identity manifests use schema version 2, immutable revision history, and compare-and-swap updates. Version-1 manifests are upgraded structurally while retaining their fingerprint and legacy mode. Unknown versions fail closed. A Chrome major change requires `POST /v1/identity-profiles/:name/migrate` with the current `expectedRevision`; migration preserves the profile's other settings and updates browser version claims. Existing parked snapshots retain their launch identity when resumed. Profile fingerprints are materialized atomically so simultaneous first launches share the same identity.

## HTTP API

All paths below are under `/v1`. Profile/site management, continuity acknowledgement and matrices require an authenticated operator. Session reads and mutations use the control service's session access checks; attribution headers are not authentication. Mutation endpoints require the applicable control lease.

| Endpoint | Input / result |
| --- | --- |
| `GET /sessions/:id/identity` | Redacted report: requested settings, observed JS capabilities, actual Chrome version, owned collector headers, contradictions, active patch inventory and limits |
| `GET /identity-profiles` | `{profiles:[...]}` without raw fingerprint bundles |
| `GET/PUT/DELETE /identity-profiles/:name` | PUT `{expectedRevision?, settings, bindings?}`; revision required for updates |
| `POST /identity-profiles/:name/capture` | `{sessionId,expectedRevision?}` captures a live identity |
| `POST /identity-profiles/:name/migrate` | `{expectedRevision,compatibilityMode?}` explicitly migrates to installed Chrome |
| `POST /identity-profiles/:name/continuity/reset` | Removes continuity baseline for the identity and its binding |
| `POST /identity/continuity/preview` | `{identityProfile?,browserProfile?,cookieSets?,egress?}` returns drift and a confirmation token |
| `GET /sessions/:id/continuity` | Fresh exact-route observation compared with the last successful baseline |
| `POST /sessions/:id/continuity/confirm` | `{token}` explicitly records the observed route as a successful baseline |
| `GET /site-profiles` | `{profiles:[...]}` |
| `GET/PUT/DELETE /site-profiles/:name` | Exact HTTP(S) origin, settings, identityProfile, permissions, extensions, interaction preferences and revision |
| `POST /site-profiles/:name/success` | `{sessionId}` marks the selected configuration successful only when the active page matches its origin |
| `GET /mobile-profiles` | Coherent emulation presets, supported capabilities, limits and real-device adapter requirements |
| `GET /sessions/:id/friction` | Current redacted observation and handoff state |
| `POST /sessions/:id/friction/scan` | Bounded observation that can pause work and request a human |
| `POST /compatibility/runs` | `{sessionId,baselineId?}` runs owned fixtures in temporary tabs |
| `GET /compatibility/runs[/id]` | Persisted reports and candidate-versus-baseline regressions |
| `POST /compatibility/matrix` | `{variants:[{compatibilityMode,mobileProfile?,headless?,baselineId?}]}`; maximum eight sequential isolated sessions, always released |

Identity settings include mode, optional UA, timezone, locale, dimensions, headless mode, mobile preset and egress. A site profile additionally holds exact-origin permissions and `interaction: {frictionDetection,actionDelayMs}`. Browser-level settings/extensions apply to the dedicated session; permissions and interaction preferences are origin-scoped. SSO navigation is not blocked simply because it leaves the selected site.

## Continuity

Continuity keys follow the saved browser, otherwise the sorted cookie-set group, otherwise the named identity. Resolved proxy endpoints are frozen before launch. Fresh Node health probes use that exact upstream; they do not pick another VPN recommendation or reuse the ten-minute overview cache. They are not browser leak tests.

`warn` allows launch while publishing drift. `require-confirmation` rejects drift or an unavailable observation unless the caller supplies the token for that exact observation. Preview before launch, inspect the changes, then resubmit with `continuityToken`. The token becomes invalid if the baseline, upstream, IP, or country changes. A successful login/task should be explicitly marked with the session confirmation endpoint; an unavailable probe cannot become a successful baseline. Public reports hash IP/upstream values; private baseline files keep the exact values without proxy credentials under the platform store's encryption and file permissions.

## Inspector and lab evidence

The inspector measures bounded browser capabilities, not page content, cookies, form values or full URL queries. Font availability is estimated by canvas metric differences; equivalent fonts can be indistinguishable. Missing graphics and collector results remain unavailable rather than being invented. The owned HTTP collector returns only allowlisted identity headers.

By default, the collector binds loopback with an unpredictable path and runs fixtures in temporary tabs. `STEEL_DIAGNOSTICS_COLLECTOR` may point to the owned external collector's origin; the inspector uses `/observe?nonce=...` and accepts only its allowlisted `headers` object. Remote workers that cannot reach the local fixture server report untested runtime checks. The external network diagnostics separately exercise supported leak channels.

Lab reports include browser version, mode, runtime, mobile preset, individual `pass`/`fail`/`untested` checks, and regressions against a named baseline. Fixtures cover same/cross-origin frames, classic/module workers with relative imports under CSP, service workers, property descriptors/errors, storage, permissions, canvas/WebGL, codec availability, download responses, keyboard input and mobile touch. Candidate fixture failures are gated; unavailable fixtures never produce a passing empty report. Hardware microphone/camera use and physical-device attestation are not exercised by these fixtures. Reports retain the latest 100 runs and latest 1,000 session identity reports.

## Friction and mobile fidelity

Opt-in friction detection observes visible challenge/one-time-code/login signals, recent main-document 403/429 responses, and rapid navigation loops. Reports include a reason and confidence. The observer publishes `friction.detected`, requests one human handoff, and never retries or submits the page automatically. Retry-After is bounded to 1 second–1 hour. Completed, declined, cancelled or expired handoffs suppress repeated notifications for the same signal until it clears. Durable runs remain subject to explicit control/resume rules. Page text and entered values are not persisted in the finding.

Mobile presets align Android UA/Client Hints, CSS viewport/screen, DPR, touch, and portrait/landscape orientation. They are desktop Chromium emulation, not Android OS or iOS/Safari. Fonts, codecs, GPU, sensors and physical input remain host-dependent. A real Android adapter uses the authenticated worker registry with engine `android` and device kind `android`. **No Android hardware was available for acceptance testing; real-device validation remains pending.** Local real-Chromium tests exercise both emulated orientations, touch, keyboard, media capability and download fixtures.

## Integration and storage

Mount `services/identity/identity.plugin` after platform and agent-features, and before cookie-health's lifecycle hook. The cookie-library service itself can register earlier. The core launcher forwards `compatibilityMode` into `BrowserLauncherOptions`. The command engine calls `identity.interactionForSession(id,url)` for exact-origin pacing; durable runs consume `friction.detected` and `handoff.waiting` to pause.

Persistent state is under `STEEL_DATA_DIR/identity`: `profiles`, `history`, `sites`, `site-history`, `continuity`, `reports`, `lab`, and `friction`. Workspace backup should retain profiles/history/sites/site-history/continuity. Platform-store encryption uses `STEEL_DATA_KEY` or `COOKIE_LIBRARY_KEY`; without one, files rely on restricted filesystem access. Public APIs never return the raw pinned fingerprint header bundle or raw route IP/upstream.
