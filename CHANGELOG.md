<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Changed

- Session rows and tabs show one glyph, not two: the agent's brand mark (or a terminal glyph) drawn in the status colour, replacing the separate coloured dot beside it. The waiting-for-input pulse stays; the running ripple does not, since a ring drawn around a mark reads as a border rather than a ripple. The collapsed session rail keeps the dot and its full ripple — there is no mark beside it to deduplicate. The sidebar's account line drops its agent mark too, now that the row already leads with one.
