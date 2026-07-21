<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- Storm-navy is now a profile icon colour (the theme-aware primary ink — navy in light, near-white in dark).

### Changed

- The profile icon picker is now a small curated set of ~60 lucide glyphs in a simple grid, all statically imported — no lazy-loaded per-icon chunks, no search, no scroll. This replaces the full searchable set, which relied on lazy chunks that could 404 behind a stale shell and never scrolled reliably in the popover.
- The profile icon "Default" now renders a neutral grey glyph rather than the navy heading ink (navy is its own explicit swatch), and the near-duplicate amber and accent swatches were dropped from the picker.
