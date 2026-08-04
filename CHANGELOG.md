<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- The left sidebar binds to the **project's own repository directory** whenever no
  session qualifies — all sessions archived, none created yet, or simply none in
  focus. Files, Changes, History, and Search were four empty panels in that
  state; now they show the project itself, as a full binding: the tree mutates,
  files open and save, Changes lists the directory's uncommitted work, History
  its commits, Search greps it, and ⌘S can place a draft in it. Needs a daemon at
  protocol 12.4 (`puddle refresh` after updating); an older one keeps the empty
  state rather than answering about the wrong repository.

### Fixed

- Untitled drafts no longer vanish from the layout when the workspace prunes dead
  sessions. Their tab carries the nil "no session" id, which the prune read as a
  session that had gone away.

### Changed

- The Layouts popover is a list again. The block above it described the current
  layout in text — name, scope, saved state, two save links — all of which the
  list itself can say, so it is gone: the filters are now the first thing under
  the title, and the **current layout wears its state in its name** — green with
  `Active` when it matches what is saved, red with `Unsaved` when it has drifted.
  A live layout that has never been saved is the one thing a list cannot show, so
  that alone keeps a head with the field that names it. Profile-wide rows lose
  their `PROFILE-WIDE` label: no project name under a row is what profile-wide
  means.
- Under project-based layout the popover shows only this project's layouts and
  the profile-wide ones, so there is exactly one current layout in the list
  instead of one per project.
- Every layout row gains **save-as** and **duplicate** beside rename and delete.
  Save-as on the current layout is just Save; on any other row it asks first,
  then writes the live layout there and adopts it. Duplicate on the current
  layout saves the live layout (unsaved changes included) under a new name; on
  any other row it copies that row. Everything saved takes the provenance the
  current setting implies, so duplicating a profile-wide layout under
  project-based layout gives this project its own copy.
- **Loading a project-scoped layout now opens that project.** It always landed in
  that project's slice, so loading one from profile-wide layout (or from the
  dashboard) changed nothing you could see; now the setting flips and the
  workspace follows to the layout's own project.
- The right sidebar's desktop shortcut is **⇧⌘B**, pairing with the left
  sidebar's ⌘B — it had never been given a desktop default and was still on the
  browser-safe ⌥⌘. (⌥⌘B is Open Worktrees, which is why the pair is ⇧⌘B rather
  than VSCode's secondary-sidebar key.) In a browser both stay as they were: the
  chrome keeps ⇧⌘B for its bookmarks bar.
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
