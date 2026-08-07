<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Changed

- The collapsed rail's session glyphs step back to 20px marks (16px in compact density) — v0.0.30's 24px filled the chip but read too heavy at rail width — and their lines thin to 0.75× stroke weight, since strokes scale with the box and marks drawn for 12px rows rasterise visibly heavier at rail size (the filled Gemini mark has no stroke to thin).
