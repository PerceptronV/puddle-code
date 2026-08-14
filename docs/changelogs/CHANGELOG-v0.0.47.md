<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [0.0.47] — 2026-08-14

### Changed

- Give source-control repository disclosure controls more breathing room from the screen edge and repository name.
- Copy an environment-variable name to the clipboard when its pane-strip label is clicked.
- Use the current file-tree location as the shared Files, Search, and Changes header, including external paths opened from the command palette.

### Fixed

- Keep wheel and trackpad scrolling in a locked render from redirecting new tabs away from the logically focused pane.
- Align per-file and directory stage controls with their source-control group action.
- Refresh file-tree Git decorations whenever the file tree is refreshed manually.
