<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- Ship standalone CLI archives with a bundled Node runtime, checksum-verified installation, and upgrades/removal independent of npm.
- Serve separate CLI and daemon installers from the deployed application, refreshed from the canonical scripts on each image build.

### Fixed

- Unify launcher protocol negotiation so older host daemons offer an update before connecting, with desktop and CLI confirmation, live-session interruption details, and compatible authority verification after the update.
