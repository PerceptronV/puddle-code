<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [0.1.3] — 2026-08-24

### Fixed

- Preserve agent transcript lines when a streaming TUI scrolls a top-anchored output region.

### Changed

- Pin the browser and headless xterm dependency to 6.0.0 while applying the narrowly scoped scrollback correction consistently to both terminal emulators.
