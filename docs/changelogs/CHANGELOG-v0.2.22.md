<!--
Archived release changelog. Governance lives in CLAUDE.md §"Changelog discipline".
-->

# Changelog

## [0.2.22] — 2026-10-14

### Added

- Pair a Home Screen app from inside Puddle using the camera QR scanner or a pasted pairing link, retaining that app's own device identity and host approval.

### Removed

- Remove the Add a host registration-code form from web Settings; register hosts through desktop Settings → Remote & Sync.

### Fixed

- Seal macOS desktop releases with an ad-hoc app signature when no Developer ID certificate is configured, verify the bundle during release, and explain notification authorisation failures with permission and signing guidance.
- Show mobile background-notification test progress and results beside their controls, reuse the service-worker registration, bound stalled browser reads, and confirm the host subscription before sending each test.
- Keep mobile settings within the viewport by allowing long account details, host names and account-security controls to wrap.
