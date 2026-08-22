<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [0.0.55] — 2026-08-21

### Fixed

- Honour the configured editor tab size instead of letting Monaco override it from file contents.
- Use each newly registered repository's checked-out clone branch as its default base instead of assuming `main`.
- Make terminal file paths clickable across every visual row when they wrap onto multiple lines.
- Preserve each terminal's scroll position when leaving and returning to its session.
