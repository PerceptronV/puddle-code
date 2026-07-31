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

### Fixed

- Waiting-input notifications silently never fired for browsers that had not granted permission: the desktop toggle defaults to on but the permission prompt only ever ran on a toggle click. The Notifications settings row now shows the live permission state (unrequested, blocked, or unsupported) with an inline request link.
- Waiting-input notifications were dropped when the session was in no cached query list (e.g. a tab parked on the dashboard); delivery now falls back to fetching the session list.

### Changed

- Swap the session status colours: a running agent now shows amber (work in motion) and one awaiting input shows green (ready for you), in both themes. Git badges, sign-in states, and caution copy move to new `--success`/`--warning` tokens so they keep their conventional green/amber hues.
