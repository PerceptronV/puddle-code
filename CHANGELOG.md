<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Fixed

- Reuse installed Node headers during CI and release dependency installation so native builds can recover from prebuilt-addon download failures without a second network request.
- Normalise ANSI colours in programme-terminal test assertions so coloured Node output does not fail CI.
