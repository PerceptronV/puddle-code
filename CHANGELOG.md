<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Fixed

- Resume catalogue-discovered Codex and OpenCode conversations against their native creation time instead of the later Puddle placement time.
- Preserve shell Up/Down history navigation across environment activation by initialising private history before user shell integrations.
