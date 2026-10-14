<!--
Archived release changelog. Governance lives in CLAUDE.md §"Changelog discipline".
-->

# Changelog

## [0.2.20] — 2026-10-14

### Added

- Show the recognised foreground agent's icon in terminal sessions, restoring the terminal icon when it exits or is suspended; add the optional `detected_agent_type` hint in daemon/cockpit protocol **22.1** (remote protocol remains **3**).

### Added

- Add opt-in background Web Push for paired browsers, with device-local permission and delivery tests, an installable mobile app manifest, and generic alerts that keep session content on the host (protocol 22.4; remote protocol remains 3).

### Fixed

- Deliver completion events for agents in plain terminals and unrequested agent exits, use native Codex turn events, and subscribe the mobile workspace with service-worker notification delivery (protocol 22.3).
- Deliver desktop notifications through the native shell, report failures and provide a test button instead of assuming that desktop permission is granted.
- Allow notifications while Puddle is focused by default, with a background-only preference in daemon/cockpit protocol **22.2**.
- Realign editor bracket highlights, selections and carets when the self-hosted font finishes loading.
- Refresh eager compilation PDFs when the completed result advances, so polling during a build cannot reload the previous output and skip the finished PDF.
