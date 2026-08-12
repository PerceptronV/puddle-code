<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [0.0.40] — 2026-08-12

### Changed

- Show a read-only inline HEAD diff when an ordinary editor's dirty marker is clicked.
- Double the breathing room between Monaco line numbers and dirty-diff markers without shifting source text.
- Reveal clipped editor-tab filenames and source-control repository details with the constant-speed hover scroll used by History.
- Allow directory rows in repository Changes trees to stage or unstage every contained entry.
