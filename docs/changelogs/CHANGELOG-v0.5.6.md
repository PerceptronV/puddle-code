<!--
Archived release changelog. Governance lives in CLAUDE.md §"Changelog discipline".
-->

# Changelog

## [0.5.6] — 2026-11-14

### Frontend

#### Fixed

- Prevent an uncaught abort error when a host connection closes while its SSH control channel is still opening.
- Keep SSH password and 2FA prompts stable during reconnection by preventing competing background authentication and cancelling pending authentication when refreshing the connection.

### Daemon

#### Fixed

- Restore automatic cleanup of unused installed versions when Finder adds `.DS_Store`, and continue bounded cleanup every five minutes while work remains, preserving active builds, recent releases and recovery references.
