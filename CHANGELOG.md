<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Changed

- Simplify mobile change review and show vertically stacked Before/After sections with line numbers, addition/deletion colours and changed-word highlights.

### Fixed

- Clarify browser approval instructions with the Connected browsers settings path.
- Remove the spurious gap between the Connected browsers and Host identity recovery disclosures.
- Make the iOS spacebar trackpad send one arrow key per step in its direction, without exploding at line boundaries.
- Keep the mobile keyboard focused during rapid terminal key-strip taps without duplicating commands, and raise it from any tap on the strip.
