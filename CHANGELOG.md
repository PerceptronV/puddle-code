<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Fixed

- Open complete terminal URLs across soft wraps and indented TUI line breaks using the shared file-path cell mapping, and copy standalone hyperlinks as plain URLs without Markdown formatting.
- Default new projects to an empty base branch that follows the clone, and migrate existing repository defaults to empty once while retaining existing session branches.
