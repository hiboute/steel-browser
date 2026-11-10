# Work inbox, state explanations, and learned recovery

Register `workbench.plugin.ts` after the platform access, durable run, handoff,
timeline, and workflow plugins. Its source adapters use their existing services;
they do not maintain a second run or review state machine. Missing workflow
sources are returned in the inbox's `unavailable` list.

All access uses the authenticated platform principal. Agents see their own work;
operators can inspect accessible work across callers. Read and dismiss state is
encrypted with the platform store, scoped to the principal, and persists across
restart. Source changes make a previously dismissed card visible again.

## API

- `GET /v1/inbox?includeDismissed=false` returns `{items, unavailable}`. Every
  card has a stable `kind:sourceId` ID and a revision binding its source and
  personal state.
- `PATCH /v1/inbox/:id` accepts `{expectedRevision, read?, dismissed?}`.
- `POST /v1/inbox/:id/actions` accepts `{expectedRevision, action, note?,
  resolution?, contentHash?}`. Actions are `answer`, `retry`, `approve`, and
  `reject`; available actions are listed on each card. Review decisions bind to
  the exact immutable content hash. Retry also requires `X-Steel-Control` for
  its browser. Stale cards return `409`.
- `GET /v1/sessions/:id/explanation` returns the primary reason, all concurrent
  reasons, next expected event, last meaningful action, observation time, and
  unavailable telemetry. Precedence is ended/failed browser, review, handoff,
  human ownership, paused/uncertain task, queue, authentication, parking, active
  task, then inactivity.

## Recovery knowledge

`POST /v1/recovery-knowledge` captures a completed handoff with `sessionId`,
`handoffId`, `title`, `note`, `origin`, and explicitly selected timeline sequence
numbers in `selectedSteps`. Optional fields are `procedureId`, `visibility`
(`private` by default, operator-only `workspace`), and `expiresInDays` (1–365).
The origin must match the bound browser's current page. Selected actions must
fall within the handoff resolution interval. Captured form values, credentials,
and conventional secret-bearing text are redacted; such steps are not replayable.
Arbitrary secrets in unlabelled prose cannot be reliably recognized: operators
must omit secret values from resolution notes.

List with `GET /v1/recovery-knowledge`; exact origin and procedure filters are
supported. `suggestions=true` excludes expired or disabled advice. Read a
version with `GET /v1/recovery-knowledge/:id?version=N`. `PUT` creates an immutable
new version and requires `expectedVersion`; editable fields are title, note,
steps, expiry, and disabled state. `DELETE ?expectedVersion=N` removes every
version. Ownership and origin cannot be changed by editing.

Applying advice requires `POST /v1/recovery-knowledge/:id/accept` with
`{expectedVersion, sessionId, accepted:true, idempotencyKey}` and a valid
`X-Steel-Control` lease. It creates a pinned procedure and transfers control to
the durable runner through the workflow service. Only reviewed navigation,
click, wait, scroll, and selection commands are supported. Navigation remains
on the lesson's origin. Suggestions never execute automatically. An ambiguous
application is persisted and cannot be silently replayed after restart.

## Validation

`npx vitest run src/services/workbench` from `api/` exercises persistence,
deduplication, caller scope, concurrent stale actions, actual Fastify schema
compilation, immutable versions, deletion, origin binding, redaction, explicit
acceptance, idempotency, ambiguous recovery, and explanation precedence.
