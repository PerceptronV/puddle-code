<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Fixed

- Keep terminal file paths clickable across indented line breaks and padded TUI wraps, preserving line/column targets and wide-character coordinates.
- Copy mouse-selected Codex text over SSH on the first Ctrl+C or Command+C by delivering the delayed OSC 52 reply to the client clipboard; support desktop Copy and keep highlighting/replay from copying automatically.
