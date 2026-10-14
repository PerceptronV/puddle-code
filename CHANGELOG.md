<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- Add puddlang: host-executed TypeScript agent workflows, Codex exact turns and structured replies, profile/account selection, durable run records, cancellation, CLI and stdio MCP access; bundle `puddlang` with existing CLI installers (daemon protocol 23.0, remote protocol unchanged).

### Changed

- Bump daemon/cockpit protocol to 23.0 for the puddlang rollout; require matching clients and hosts through the existing approved upgrade flow, while retaining remote transport protocol 3.
