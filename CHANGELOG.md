<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Changed

- Settings → Appearance splits **project-based layout** into two independent
  toggles: **Project-based layout** now only decides whether the centre editor
  keeps a layout per project, and **All projects in the session list** (default
  on) decides whether the right sidebar lists every project's sessions or only
  the current project's. They were one setting, so a per-project editor layout
  came with a project-scoped session list whether you wanted it or not. Existing
  choices carry over untouched in both directions: a window that had
  project-based layout on keeps its scoped session list until you say otherwise.

### Fixed

- **Reopen last closed tab** (⇧⌘T) and **Close window** (⇧⌘W) did nothing in the
  desktop shell in v0.0.24. Their defaults were written `meta+shift+…`, but a
  canonical binding lists modifiers in the fixed order `ctrl`, `alt`, `shift`,
  `meta`, and the dispatcher matches by string equality — so the keydown's
  `shift+meta+KeyT` never found its action. Both are correct now, and a test
  checks every default in both shells rather than a hand-picked few. (⇧⌘W had
  also stopped closing the window outright, since v0.0.24 moved the key off the
  menu accelerator and onto the renderer.)
