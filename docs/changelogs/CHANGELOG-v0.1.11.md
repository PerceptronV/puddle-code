<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [0.1.11] — 2026-09-07

### Fixed

- Keep overflowing session sidebars within their own scroll regions instead of scrolling the whole workspace.
- Keep routed panes and nested scroll surfaces from extending or rubber-banding the cockpit viewport.
