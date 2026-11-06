<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Cockpit

#### Added

- Add customisable ⌘0–⌘9 shortcuts for the first ten non-archived projects in profile order, with current bindings shown in the command palette; move desktop Reset Zoom to ⌥⌘0.

#### Fixed

- Render Ripple over a full-size terminal with a draggable, row-anchored native-input boundary. Follow CLI scrolling, relay wheel input, reflow full-width prose, preserve ANSI styling, and show Codex prompts as user bubbles while retaining native controls and shared Markdown/Mermaid/LaTeX rendering.
