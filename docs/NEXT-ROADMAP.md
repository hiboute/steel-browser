# Steel next roadmap

This is the next expansion after the deployed PR #7 roadmap. It is tracked in
[homelab #626](https://github.com/hiboute/homelab/issues/626). The features below are
approved scope; a listed feature is not a claim of implementation or deployment.

## Workstreams and feature issues

- [Browser identity inspector](https://github.com/hiboute/homelab/issues/627) — identity
- [Versioned identity profiles](https://github.com/hiboute/homelab/issues/628) — identity
- [Browser-level leak checks](https://github.com/hiboute/homelab/issues/629) — infra
- [Strict egress mode](https://github.com/hiboute/homelab/issues/630) — infra
- [Stealth and compatibility lab](https://github.com/hiboute/homelab/issues/631) — identity
- [Auditable fingerprint patches](https://github.com/hiboute/homelab/issues/632) — identity
- [Account egress continuity](https://github.com/hiboute/homelab/issues/633) — identity
- [Site compatibility profiles](https://github.com/hiboute/homelab/issues/634) — identity
- [Automatic friction detection](https://github.com/hiboute/homelab/issues/635) — identity
- [Real desktop browser workers](https://github.com/hiboute/homelab/issues/636) — infra
- [Mobile fidelity profiles](https://github.com/hiboute/homelab/issues/637) — identity
- [Human and agent control ownership](https://github.com/hiboute/homelab/issues/638) — platform
- [Commands API for every session](https://github.com/hiboute/homelab/issues/639) — platform
- [Durable task runs](https://github.com/hiboute/homelab/issues/640) — platform
- [Verified completion receipts](https://github.com/hiboute/homelab/issues/641) — product
- [Reusable procedures](https://github.com/hiboute/homelab/issues/642) — product
- [Scheduled procedures and triggers](https://github.com/hiboute/homelab/issues/643) — product
- [Review before submission](https://github.com/hiboute/homelab/issues/644) — product
- [Named checkpoints and branches](https://github.com/hiboute/homelab/issues/645) — platform
- [Browser failure doctor](https://github.com/hiboute/homelab/issues/646) — platform
- [Grounded extraction](https://github.com/hiboute/homelab/issues/647) — data
- [Meaningful page diffs](https://github.com/hiboute/homelab/issues/648) — data
- [Agent work inbox](https://github.com/hiboute/homelab/issues/649) — UI and harness
- [Explain current state](https://github.com/hiboute/homelab/issues/650) — UI and harness
- [Vault-assisted login and forms](https://github.com/hiboute/homelab/issues/651) — data
- [Artifact processing](https://github.com/hiboute/homelab/issues/652) — data
- [Pair a dedicated desktop profile](https://github.com/hiboute/homelab/issues/653) — infra
- [Browser fleets across locations](https://github.com/hiboute/homelab/issues/654) — infra
- [Fair scheduling and budgets](https://github.com/hiboute/homelab/issues/655) — platform
- [Workspace export and recovery](https://github.com/hiboute/homelab/issues/656) — data
- [Regression replay](https://github.com/hiboute/homelab/issues/657) — product
- [Session search](https://github.com/hiboute/homelab/issues/658) — data
- [Additional browser engines](https://github.com/hiboute/homelab/issues/659) — infra
- [Learn from human handoffs](https://github.com/hiboute/homelab/issues/660) — UI and harness
- [Test the exact production browser image](https://github.com/hiboute/homelab/issues/661) — infra

## Delivery requirements

Each feature must have working behavior, meaningful tests, reviewable changes and
live verification before its issue is closed. Physical-device checks remain
explicitly pending when the device is unavailable. Browser emulation does not
claim native-device fidelity; WebKit testing does not establish Safari support.

Integrate shared caller authentication, fenced control ownership, per-session
command engines and durable runs before dependent workflow features. Keep
uncertain external mutations paused for reconciliation. Candidate releases must
be tested in the exact production browser image before promotion. Preserve the
create PR, ready for review, merge and deployment verification sequence.
