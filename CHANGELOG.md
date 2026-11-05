<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Cockpit

- Avoid full-screen terminal redraws for cursor-only synchronised updates while preserving buffered output and the terminal's refresh timeout.

- Improve compact project-rail label sizing and vertical spacing; align selection and hover fills during dialogue scaling, and dismiss tab actions after pointer exit without losing keyboard access.

- Keep PDF zoom controls over the visible document instead of below its viewport; allow overlay trays to override their default positioning.
