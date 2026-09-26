<!--
Archived release changelog. Governance lives in CLAUDE.md §"Changelog discipline".
-->

# Changelog

## [0.2.12] — 2026-09-26

### Fixed

- Keep terminal file paths clickable across indented line breaks and padded TUI wraps, preserving line/column targets and wide-character coordinates.
- Copy mouse-selected Codex text over SSH on the first Ctrl+C or Command+C by delivering the delayed OSC 52 reply to the client clipboard; support desktop Copy and keep highlighting/replay from copying automatically.
