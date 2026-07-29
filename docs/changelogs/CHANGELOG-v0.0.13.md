<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [0.0.13] — 2026-07-28

### Changed

- Desktop (macOS): the native title bar is gone — the cockpit's own top bar (host, ⌘K field, settings, scratchpad, profile) doubles as a taller drag-region title bar with the traffic lights inlaid.
- The window/tab title now names the project and the machine (host display-name customisation first, then hostname) instead of the literal "puddle".
- Desktop: copyright credits Yiding Song (About panel / bundle metadata); the package is `@puddle-code/desktop`.

### Fixed

- Desktop (macOS): the app icon no longer sits on a white plate on macOS 26 — the icns now ships full-bleed artwork (`build/icon-mac.svg`) and the OS applies its own squircle mask; Linux keeps the self-rounded `icon.svg`.
