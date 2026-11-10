# Procedures, reviews and verified results

The workflow service builds on the session-scoped command engine and durable run
service. Definitions and decisions use encrypted `PlatformStore` storage when
`STEEL_DATA_KEY` is configured. All routes require a verified principal. Operators
can inspect work across principals; agents can inspect their own work. The
`X-Steel-Client` attribution header does not grant access.

## Procedures

`POST /v1/procedures` creates an immutable first version. Updating with
`PUT /v1/procedures/:id` requires `expectedVersion` and adds a new version.
`GET /v1/procedures/:id/versions` returns the history. Existing runs retain their
compiled steps and version even when the procedure changes or is deleted.

Inputs use JSON Schema. An exact `{"$input":"customer.name"}` object substitutes
the corresponding typed input; strings are not evaluated or interpolated as
code. JSON schema validation executes in a bounded worker. Procedures can contain
command requests, read-only assertions, or approved `vault_fill` references.
Selected command actions can be saved through `/procedures/from-actions`;
arbitrary timeline text and raw CDP records are not automatically executable.

```json
{
  "name": "Read a fixture title",
  "inputSchema": {
    "type": "object",
    "properties": { "url": { "type": "string" } },
    "required": ["url"],
    "additionalProperties": false
  },
  "steps": [
    {
      "id": "open",
      "kind": "commands",
      "input": { "commands": [{ "command": "navigate", "url": { "$input": "url" } }] }
    },
    {
      "id": "check",
      "kind": "assert",
      "assertion": {
        "id": "title",
        "label": "Expected page title",
        "command": { "command": "get", "what": "title" },
        "operator": "equals",
        "expected": "Fixture"
      }
    }
  ]
}
```

Start with `POST /v1/procedures/:id/run` and
`{ "version": 1, "inputs": { "url": "https://fixture.example/" }, "idempotencyKey": "job-123" }`.
The runner creates a fresh owned session unless `sessionId` is supplied. An
existing controller must explicitly transfer its lease using `X-Steel-Control`.
The token is never saved in a definition or run. Cancellation and uncertain
external-action reconciliation use the durable run APIs.

Recovery instructions are editable versioned guidance; they do not silently
execute after a failure. Vault steps contain `{kind:"vault_fill", id, reference,
selector, frameUrl?}`. The referenced origin and access policy come from the
configured vault, never from the procedure. Resolved secret values are not stored
in procedure steps, results or receipts.

## Review points

Add `review` to a command step to pause immediately before it:

```json
{
  "summary": "Submit the completed application",
  "destination": "https://fixture.example/apply",
  "fields": { "name": { "$input": "name" } },
  "attachments": [{ "name": "cv.pdf", "artifactId": "artifact-id", "sha256": "64-hex-digest" }]
}
```

The exact proposal, compiled command and a redacted prepared-page snapshot form a content hash. The operator reads
`GET /v1/reviews/:id`, then posts `{decision:"approve"|"reject",contentHash}` to
`/v1/reviews/:id/decision`. Agents cannot approve their own submissions. A stale
hash or a second decision returns a conflict. Approval survives restart and binds
only to the immediately following immutable command. The browser's observed
prepared state must still match immediately before submission. A changed state
pauses the run and requires a newly prepared review; approval does not silently
authorize changed form contents. Reviewed attachments are rehashed before review
and again before execution through the artifact access-control adapter. Rejection cancels the run.
Review points are selected by the procedure author; ordinary actions have no
automatic approval requirement.

## Completion receipts

`GET /v1/receipts/:runId` reconciles durable results into a receipt. Status is
`verified` only when the run completed and at least one declared assertion was
observed and all passed. No assertions, unavailable observations and uncertain
external outcomes cannot produce a verified receipt. Failed checks remain visible
with source URL, observation time and the bounded observed value. Assertions
cannot evaluate scripts or mutate pages, and form-value reads are excluded.

Screenshot evidence is explicit and owner scoped. The integration must provide
an evidence/sensitivity policy; without it, screenshots are not saved. Vault-marked
sensitive sessions suppress persisted screenshots and receipt values. Live CDP
and viewers inherently retain access to page content. Evidence downloads have
`Cache-Control: private, no-store`.

## Schedules, webhooks and watcher triggers

`POST /v1/procedure-schedules` pins a procedure ID/version and validated inputs.
Supported triggers are `{kind:"interval",everySeconds}`, `{kind:"daily",at:"HH:mm",
timezone:"Asia/Kolkata"}`, `{kind:"webhook"}`, and
`{kind:"watcher",watcherId,onlyMatched:true}`. Daily schedules skip nonexistent DST
wall times and run once on dates with repeated hours.

`missedRun` is `skip` or `run_once`; `maxLatenessSeconds`, `maxConcurrent` and
`deadlineSeconds` make late work and resource limits explicit. Due deliveries are
persisted before creating a run and use stable idempotency keys after restart.
Deadline enforcement cancels outstanding scheduled runs. History records started,
skipped and failed deliveries; cancelling a run uses its normal run endpoint.

A webhook schedule returns its token once. Updating it rotates the token. Send
`POST /v1/procedure-triggers/:id` with `X-Steel-Webhook-Token` and a stable unique
`Idempotency-Key`. Only its hash is stored, and list responses omit the hash.
The deployment's ordinary API authentication remains required where configured.

## Regression replay

`POST /v1/regression-replays` takes a verified `baselineRunId`, the identical
`inputs`, `candidate:{label,sessionOptions}`, `allowedOrigins`, `allowMutations`
(default false), and `idempotencyKey`. It pins the baseline procedure version and
starts a fresh local browser with no saved profile, login, extension or secret
access. Candidate options are limited to `headless`, `dimensions`, `timezone`
and `egress`. Remote fleet engines have their separate capability protocol and
are not silently treated as local Chromium sessions.
Fresh replay sessions are released at completion or cancellation while their
network guard is still active. Browser shutdown precedes removal of the guard,
so delayed page scripts cannot start unguarded requests after the test finishes.

Every fixture origin must appear in operator configuration
`STEEL_REPLAY_ORIGINS` (comma separated HTTP(S) origins). Local owned fixtures also
require `STEEL_REPLAY_ALLOW_PRIVATE_NETWORKS=true`. The request guard persists
across all steps and pauses, checks redirects and frames, and blocks popups,
workers and connections outside the fixtures. Replay excludes arbitrary scripts,
tab creation and uploads. Fixture mutations additionally require an operator's
explicit `allowMutations:true`.

Run this endpoint inside each candidate API image to test its actual browser.
The result records observed browser version and `STEEL_BUILD_REVISION` when
provided; the caller's candidate label is descriptive, not version attestation.
The exact-image CI job supplies the image digest separately. Comparisons report
changed/missing observations, changed assertion status and blocked network
requests. Dynamic values should be excluded or normalized by the declared
assertions; differences are reported rather than silently accepted.

## Workspace recovery integration

`workflowService.exportResources(actor)`, `validateResources(value,actor)` and
`importResources(value,actor,conflict)` integrate with encrypted workspace backup.
The schema is versioned; all immutable procedure versions are included. Restore
validates definition hashes, owners and schedule references before one atomic
manifest replacement. Conflicts fail unless explicitly set to `skip`. Restored
schedules are disabled and webhook secrets are omitted, so restoring cannot
unexpectedly submit work or revive a delivery credential.

Tracking: homelab issues #641, #642, #643, #644 and #657, under #626.
