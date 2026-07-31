<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- Narrow-viewport (phone) workspace layout: below 768px the sidebars open as overlays from their rails instead of crushing the terminal, dismissing on backdrop tap or navigation; hover-revealed controls (tab closes, row menus, card actions) are always visible on touch devices.

### Changed

- Swap the session status colours: a running agent now shows amber (work in motion) and one awaiting input shows green (ready for you), in both themes. Git badges, sign-in states, and caution copy move to new `--success`/`--warning` tokens so they keep their conventional green/amber hues.
