<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Fixed

- Terminal now honours OSC 52 clipboard writes, so a mouse-reporting agent's own copy (e.g. Claude Code auto-copying the selection) lands in the system clipboard and ⌘V pastes it — no Shift+drag needed.
