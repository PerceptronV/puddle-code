<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [0.2.5] — 2026-09-23

### Added

- Add a public `/guide` page with editable Markdown setup and component-management instructions, linked below sign-in buttons and above the signed-in project list; redirect old `/faq` links to the guide.
- Add a guide table of contents and GitHub-style Markdown alerts; clarify component dependencies, supported commands and platform-specific management.
- Ship standalone CLI archives with a bundled Node runtime, checksum-verified installation, and upgrades/removal independent of npm.
- Serve the CLI installer at `/install.sh` from the deployed application and new releases; install daemon/desktop components through the CLI while retaining automatic GitHub daemon bootstrap on first connection.

### Fixed

- Unify launcher protocol negotiation so older host daemons offer an update before connecting, with desktop and CLI confirmation, live-session interruption details, and compatible authority verification after the update.
