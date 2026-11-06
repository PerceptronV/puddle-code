<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Cockpit

#### Fixed

- Use the lighter file-hover fill for accented form fields and inactive switches, preserving default controls and stronger island borders.

- Preserve the original default theme and soften preset/custom accent backgrounds to one-third strength. Keep reading areas and active tabs untinted, match pane frames to sidebars, and strengthen accent borders beyond all background layers.

- Keep Ripple active for Codex and other alternate-screen agents, rendering current screen contents with copyable text, Mermaid and LaTeX while preserving native CLI controls.

- Clicking, tapping or scrolling closed session transcripts no longer raises connection errors from restored terminal mouse reporting.
