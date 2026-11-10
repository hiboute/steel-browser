# Evidence, documents, secrets and recovery

This module implements homelab issues #647, #648, #651, #652, #656 and #658.
Register `services/data/data.plugin.ts` after the control/access, platform,
extras and agent-feature plugins. It deliberately refuses to start without the
access service. Workshop and MCP must use the authenticated principal; the
`X-Steel-Client` attribution header is not an authorization boundary.

## Grounded extraction

`POST /v1/extract` retains its existing input and adds `observedAt`, `extractionId`
and `evidence[]`. Evidence uses JSON-pointer paths and reports `grounded`,
`uncertain` or `missing`. A grounded value occurs verbatim in the captured source;
the response includes the excerpt and a DOM selector where available. This is
lexical evidence, not proof that the model associated a value with the correct
field. Boolean/inferred values and unsupported values remain uncertain. Missing
optional schema fields are reported explicitly. The model cannot invent its own
citations because evidence is computed after extraction from the captured text.

The page URL, source and time are captured together. Form controls, editable
regions, scripts and marked secret fields are removed before model input.
Known vault values reflected elsewhere are also masked. Source URLs omit
credentials, query strings and fragments. Captures are bounded to the configured
extraction size; evidence only describes the captured portion.

## Page snapshots and diffs

- `POST /v1/sessions/:id/page-snapshots` accepts optional `name`, `selector`,
  `ignoreSelectors`, `ignorePatterns` and `visual`. Ignore patterns are literal
  strings, avoiding unbounded regular-expression execution.
- `GET /v1/page-snapshots?sessionId=...`, `GET /v1/page-snapshots/:id`,
  `GET /v1/page-snapshots/:id/image` and `DELETE /v1/page-snapshots/:id` manage
  retained captures. Images are encrypted with the platform store and returned
  through an authorized, non-cacheable route.
- `POST /v1/page-diffs {before,after}` compares captures of the same URL and
  capture options. It returns added/removed text, changed DOM blocks and an
  optional pixel-change ratio. Visual comparisons tolerate channel differences
  of at most 12/255. Dimensions or color-format changes are reported explicitly.

Watchers can set `pageDiff: {selector?,ignoreSelectors?,ignorePatterns?,visual?}`.
Their first run establishes a baseline. Later runs preserve snapshot IDs and
diff evidence in history and notifications. A visual change can trigger the
`changed` condition even if text is unchanged. Changing URL or ignore options
resets the baseline. A missing/expired baseline establishes a new baseline.

Snapshot and search records expire after 30 days. Access is checked against the
record owner and the current session access policy when the session still exists.

## Vault-assisted filling

Configure `STEEL_VAULT_REFERENCES` as JSON in deployment configuration. Values
are references, not supplied by the calling agent:

```json
{
  "example-login": {
    "label": "Example account password",
    "provider": "env",
    "locator": "EXAMPLE_LOGIN_PASSWORD",
    "origin": "https://accounts.example.org",
    "selectors": ["#password"],
    "clients": ["approved-agent"]
  }
}
```

Supported providers are mounted environment variables, configured absolute
secret-file paths (`file`) and configured `op://` references (`op`, requiring an
installed, authenticated 1Password CLI). References can have `expiresAt`.
`GET /v1/vault/references` returns only approved metadata, never the locator or
value. `POST /v1/sessions/:id/vault/fill` takes
`{reference,selector,frameUrl?}` and requires the active control lease. The top
page and selected frame must both match the reference's exact HTTPS origin.
The origin and target are checked again in the same page evaluation as the fill.
The operation never submits the form.

Before filling, Steel enables private capture for the browser, stops recording,
persists a sensitive-session marker and disables saved timeline/snapshot images.
Private capture drops browser instrumentation payloads, including CDP arguments,
console and network bodies; the structured `vault.filled` audit contains only
reference/origin/selector. This mode survives park/resume through the platform's
internal `privateCapture` launch flag. The field is marked sensitive and visually
masked, and the command engine excludes it from ordinary text reads.

Internal durable runners call
`server.dataVaultFill(id, actor, input, {signal, assertControl})`. The guard must
validate the specific lease/fencing token, and is checked again after the secret
provider returns. A takeover during retrieval cannot fill with the old lease.
Saved screenshot producers must check `isSensitiveSession(id)` first.

This does not make credentials inaccessible to the target website, a raw-CDP
controller, the live viewer, or a browser extension. Those interfaces inherently
control the page. Profile, cookie and external-site protections remain necessary.

## Artifact processing

`POST /v1/sessions/:id/artifacts/process {path,ocr?,destination?}` validates a
session file, computes SHA-256 and processes PDF, PNG, JPEG, TIFF or text files.
Files are limited to 25 MiB. PDFs are limited to 50 pages; image decoding to
8 million pixels; extracted text to 1 million characters; execution to 60 seconds.
At most two documents process concurrently. Cancellation terminates the worker
and any active OCR subprocess, and removes temporary files.

MuPDF extracts real PDF text and geometric table candidates. Tables are labeled
`method: geometry-candidate` and `confidence: unverified`: column alignment does
not establish semantic table structure. With `ocr:true`, Tesseract recognizes
images and PDF pages that contain no text. OCR requires `tesseract-ocr` and the
English language data in the runtime image; missing capability returns an
explicit error. Native text PDFs do not need OCR. No model invents OCR output.

`GET /v1/artifacts` lists metadata; `GET /v1/artifacts/:id` returns the result.
Deleted or modified source files invalidate their stored evidence. Review
workflows call `artifactProcessing.verify(id, actor, expectedSha256)` both before
review and immediately before using an attachment; it hashes the actual file.

Optional `STEEL_ARTIFACT_DESTINATIONS` maps operator-defined destination names to
local mounted directories. A caller selects only a configured name. Outputs use
a content-hash-prefixed sanitized filename and atomic writes; arbitrary network
destinations and caller-selected absolute paths are not accepted.

## Encrypted workspace recovery

`GET /v1/workspace/scopes` lists available scopes: profiles, logins, workflows,
watchers, warm and identities. Workflows includes its encrypted manifest and
runtime records; it is not a definitions-only procedure export. Identities
includes versioned profiles, site profiles, histories and continuity metadata,
excluding ephemeral diagnostic reports.

An operator calls `POST /v1/workspace/export {scopes,passphrase}`. All browsers
must be parked/released and queued work cleared. The platform admission barrier
blocks starts/resumes for the export. Changing source files abort the capture.
Exports reject symlinks, omit Chrome lock/cache files, and cap uncompressed data
at 50 MiB/20,000 files. The result's `archive` is authenticated AES-256-GCM with a
random salt/IV and scrypt-derived key, independently encrypted from stored data.
Keep the export passphrase and the original `STEEL_DATA_KEY` /
`COOKIE_LIBRARY_KEY` separately; key material is never included. Existing store
encryption requires those original keys after restore.

`POST /v1/workspace/restore {archive,passphrase,scopes,conflict}` authenticates and
validates the whole archive before staging any selected scope. It returns
`status: staged`, `stageId`, `automationDisabled: true` and `restartRequired: true`. The live workspace is
unchanged. To activate, stop the API and every worker sharing its volumes, then
run a one-off container with those volumes and the same environment:

```sh
node build/services/data/workspace-recovery.js activate STAGE_ID --service-stopped
```

`conflict` is `reject` (refuse nonempty destinations) or explicit `replace`.
Activation prepares copies on each target filesystem and swaps directories,
retaining original directories for rollback. Restored workflow schedules, watchers and warm browsers are disabled; workflow webhook hashes are removed. Re-enable selected automation and issue fresh webhook credentials only after reviewing the restored state. An interrupted activation has a
journal; retrying activation first rolls it back. To undo a completed activation:

```sh
node build/services/data/workspace-recovery.js rollback STAGE_ID --service-stopped
```

The command's stopped-service flag is an operator assertion, not a process
detector. Restart only after activation succeeds and the original store keys are
installed. Retained rollback directories and recovery stages contain sensitive
data and require deliberate deletion after a successful recovery drill. Browser
restoration never reverses server-side website actions.

## Session search and integration

`GET /v1/search?q=...&sessionId=...&kind=...&limit=...&cursor=...` searches captured
extractions, snapshots, processed documents and registered workflow metadata.
Queries support Unicode, AND terms, filters and bounded numeric pagination. Searches stream at most 10,000 records with a five-second scan deadline; `truncated: true` reports a deadline-limited result. Snapshot/artifact listings are capped at 200 records or 16 MiB per response.
The result contains local source links, timestamps and short snippets. Only
owner/operator-visible records whose source still passes its access/existence
check are returned. Denied reads never delete another caller's index record.

Other plugins register source checks with
`server.sessionSearch.registerSource(kind, async (document, actor) => boolean)`
and index only approved safe metadata via `sessionSearch.index(...)`. Unknown
source types fail closed. Source deletion calls `sessionSearch.remove(kind,id)`;
expiry follows the source's retention. Avoid indexing raw procedure steps,
inputs, vault values or arbitrary command results. Snapshot/artifact/extraction
indexing is automatic, and artifact results are rechecked against source files.

Validation includes real Chrome capture/ignore/diff/fill/extraction, actual PDF
text/table extraction, actual Tesseract OCR, changed-attachment hashes, control
takeover during provider retrieval, owner/access denial, encrypted restore and
rollback, and watcher baseline/history/notification behavior. Deployment and
production validation are tracked separately in the linked issues.
