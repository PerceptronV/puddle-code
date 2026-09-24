<!--
Archived release changelog. Governance lives in CLAUDE.md §"Changelog discipline".
-->

# Changelog

## [0.2.8] — 2026-09-24

### Added

- Register each host profile independently with a remote account, with separate browser approvals, identities and controls; restrict remote discovery, session operations and terminal events to that profile.
- Show the bundled connector’s remote protocol as a `-cN` suffix on the daemon line in `puddle --version`, using offline metadata without changing compatibility comparisons.

### Changed

- Require `--profile <profile-id>` for remote CLI administration; keep `remote run` as the supervisor for all registrations.
- Advance daemon/cockpit protocol to 22.0 and remote protocol to 3 for profile-scoped authority; delete legacy host-wide registrations and revoke their approvals on connector startup, retrying relay removal when offline.
- Switch to Files and reveal the file when clicking a filename in Search; keep per-line results in Search.

### Fixed

- Leave 2.5 rows of blank space below file trees so the directory context menu remains accessible in long lists.
