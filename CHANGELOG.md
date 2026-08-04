<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Fixed

- Opening a project no longer blanks the page. The workspace called the
  archive-by-drag mutation hook _after_ its loading gate returned early, so the
  moment the gate flipped (ui state loaded, chunks warm) the hook count changed
  mid-life and React tore the tree down with error #310. Regression in v0.0.22.

### Changed

- Lint enforces the Rules of Hooks (`react-hooks/rules-of-hooks`) across every
  package's React source, so a hook after an early return fails CI instead of
  shipping.
