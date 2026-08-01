<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Changed

- Tab chips shrink back to their title: the minimum width added in 0.0.17 is now just wide enough for the preview and close icons, rather than wide enough to keep a short filename legible beneath them. Chips still never resize on hover.

### Fixed

- Unpinning the sidebar while browsing above the worktree now returns the file tree to the active session's worktree. Entering a parent directory pins the sidebar, but releasing that pin left the tree stranded in the browse — it was keyed to the bound session, and unpinning does not change which session is bound, only how it is resolved.
