<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Fixed

- **Reopen last closed tab** (⇧⌘T) and **Close window** (⇧⌘W) did nothing in the
  desktop shell in v0.0.24. Their defaults were written `meta+shift+…`, but a
  canonical binding lists modifiers in the fixed order `ctrl`, `alt`, `shift`,
  `meta`, and the dispatcher matches by string equality — so the keydown's
  `shift+meta+KeyT` never found its action. Both are correct now, and a test
  checks every default in both shells rather than a hand-picked few. (⇧⌘W had
  also stopped closing the window outright, since v0.0.24 moved the key off the
  menu accelerator and onto the renderer.)
