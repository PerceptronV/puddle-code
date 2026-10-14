<!--
Archived release changelog. Governance lives in CLAUDE.md §"Changelog discipline".
-->

# Changelog

## [0.3.0] — 2026-10-14

### Added

- Add puddlang: host-executed TypeScript agent workflows, Codex exact turns and structured replies, profile/account selection, durable run records, cancellation, CLI and stdio MCP access; bundle `puddlang` with existing CLI installers (daemon protocol 23.0, remote protocol unchanged).

### Changed

- Bump daemon/cockpit protocol to 23.0 for the puddlang rollout; require matching clients and hosts through the existing approved upgrade flow, while retaining remote transport protocol 3.
