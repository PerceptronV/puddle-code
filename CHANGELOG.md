<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Changed

- The collapsed rail's session glyphs settle at 16px marks (12px in compact density) at 0.75× stroke weight — v0.0.30's 24px filled the chip but read too heavy at rail width, and strokes scale with the box, so marks drawn for 12px rows rasterise visibly heavier when enlarged (the filled Gemini mark has no stroke to thin). Unlike the pre-v0.0.30 rail, the mark full-bleeds its box instead of floating a 12px icon in a 16px one.
