<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- The homescreen gains two action tiles in the projects grid: "Open project" (the new-project dialogue) and "Open terminal" — a shell at `~` on the daemon host in a heading-less bottom pane that exists only on the homescreen, for cloning repositories before opening them as projects. One shell at a time: while it lives, opening reattaches to it (the tile reads "Close terminal", which ends it). Protocol 7.5: the `home` PTY stream and the `kill-shell` WS message.
- Storm-navy is now a profile icon colour (the theme-aware primary ink — navy in light, near-white in dark).

### Changed

- The profile icon picker is now a small curated set of ~60 lucide glyphs in a simple grid, all statically imported — no lazy-loaded per-icon chunks, no search, no scroll. This replaces the full searchable set, which relied on lazy chunks that could 404 behind a stale shell and never scrolled reliably in the popover.
- The profile icon "Default" now renders a neutral grey glyph rather than the navy heading ink (navy is its own explicit swatch), and the near-duplicate amber and accent swatches were dropped from the picker.
- Scratchpad entries drag from anywhere on the row (the grip handle is gone, reclaiming the left gutter), and editing now happens in a modal opened by clicking the row (or the `+`/pencil) rather than expanding inline.
- Deleting a Scratchpad entry now asks for confirmation inline — a warning line with Delete/Cancel — instead of removing it on the first click, since there is no undo.
