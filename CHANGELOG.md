<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Fixed

- Repaint terminal canvases after scrollback replay and when a hidden browser tab returns, preventing text from remaining blank until selected after a long suspension.
- Route the save shortcut to the focused pane's active tab, preventing a previously focused untitled editor in another pane from intercepting it.
