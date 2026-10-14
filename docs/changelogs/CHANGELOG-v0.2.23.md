<!--
Archived release changelog. Governance lives in CLAUDE.md §"Changelog discipline".
-->

# Changelog

## [0.2.23] — 2026-10-14

### Changed

- Agent notifications show the conversation name and a bounded snippet of its last output. Mobile background previews are encrypted between the approved host and device, with generic alerts retained for older hosts/services.

### Fixed

- Clicking a notification opens its exact session on desktop, web and mobile, including after a renderer reload or a cold Home Screen launch. Login preserves the destination; unavailable sessions no longer open an unrelated conversation.
