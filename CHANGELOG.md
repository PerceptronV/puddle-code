<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Changed

- Require two native caret steps per arrow when using the iOS spacebar trackpad, ignoring smaller movements.
- Use Puddle’s PDF viewer for ordinary PDFs as well as LaTeX output, with per-tab scroll and zoom restoration.

### Fixed

- Send spaces and capital letters only once when typing into the iOS terminal.
- Preserve PDF scroll progress and zoom when switching tabs or projects and refreshing compiled output.
- Preserve independent source, untitled, diff, Markdown, HTML and mobile text view positions across tab/project switches; avoid repeating old source-navigation jumps.
- Keep saved agent and shell scroll positions until the initial terminal replay completes, so a workspace remount cannot reset them to the bottom.
- Anchor PDF pinch zoom to the page point under the pointer or touch midpoint after the new page sizes are committed.
