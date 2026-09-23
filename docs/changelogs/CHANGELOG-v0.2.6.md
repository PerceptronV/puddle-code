<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [0.2.6] — 2026-09-23

### Fixed

- Fix standalone CLI distribution checks on Linux and macOS by retaining gzip on the isolated PATH and invoking system utilities at their original paths.
