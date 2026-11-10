# Workshop operations

The Work section groups durable tasks and retained evidence alongside the existing
browser tools. Every action calls the API and surfaces its returned validation or
availability error. Empty worker or vault lists do not imply that hardware or
secret providers are configured.

- **Sessions:** observe by default, then use **Take control** before changing a
  browser. The tab keeps its lease only in memory and renews it while visible,
  including when you switch Workshop pages. Taking control pauses agent work;
  releasing control does not automatically resume a task. Reloading loses the
  local token, so take control again. Parked sessions also support taking control
  before resume. A selected session never falls back to another browser.
- **Work inbox:** read, dismiss, answer handoffs, reconcile uncertain task steps,
  or approve the exact prepared action. Approvals bind the current content hash;
  the backend requires a verified operator credential. Reconciliation requires
  the interrupted step ID, a verified applied/not-applied outcome, and evidence.
- **Procedures & runs:** create immutable procedure versions, run them with pinned
  inputs, inspect task progress, review fields and attachments, verify outcome
  receipts, schedule triggers, or compare a candidate on configured owned test
  origins. Advanced command/schema editing remains explicit. An existing-session
  run transfers the current lease to its runner.
- **Recovery knowledge:** save selected actions or notes from a completed handoff.
  Review and edit a lesson before applying an exact version. The browser must
  still be on the lesson's verified origin. Accepting starts a durable procedure;
  simply opening a suggestion never executes it.
- **Identity & compatibility:** inspect requested versus observed identity, manage
  identity and site profiles, review mobile emulation limits, scan site friction,
  compare compatibility runs, and confirm account-network changes. Session launch
  can preview continuity and require a reviewed confirmation token.
- **Evidence & workspace:** search permitted retained sources, capture page
  baselines with noise exclusions, compare snapshots, process downloaded
  documents, fill an approved secret reference without submitting, or export an
  encrypted archive. Restore validates and stages offline activation; the live
  workspace is not replaced by the UI. Keep original store keys separately.
- **Browser operations:** capture named checkpoints and branch new browsers,
  inspect bounded diagnostic evidence, run command batches, and configure client
  and site capacity. A checkpoint preserves browser state, not external website
  side effects. Capacity changes require idle browsers.
- **Browser fleet:** pair workers with one-use tokens, inspect advertised engines
  and health, drain or revoke them, start sessions on matching workers, and send
  capability-supported commands under an explicit lease. Uncertain worker
  results require reconciliation. Mobile Chromium emulation is distinct from
  actual Android hardware.

Structured extraction shows evidence and uncertainty per field. Watchers can
compare text and visual page changes while excluding selected noisy regions.
Existing saved logins, downloads, recordings, warm browsers, egress, and activity
remain available in the Browsers section.

Browser verification instructions are in [ui/test/README.md](../ui/test/README.md).
