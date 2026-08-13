<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [0.0.42] — 2026-08-13

### Added

- Add locked Markdown and HTML preview slots that follow the active renderable tab and its proportional vertical scroll position.

### Fixed

- Keep short file tabs content-sized like agent and terminal tabs.
- Return newly spawned Codex and OpenCode sessions immediately while safely capturing their native conversation IDs in the background, including agents spawned from a tab’s worktree menu.
