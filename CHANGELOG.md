<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- Right-clicking a project in the session sidebar can now edit its label:
  **Change project name** on the expanded header, **Change project abbreviation**
  on the collapsed rail. Both open the same in-place editor a double-click has
  always opened — which was the only way to find it.
- A **`+`** in the Layouts header, where the Scratchpad's is: it opens the same
  name field an unsaved layout shows, saves the **live** layout under that name
  (provenance from the project-based-layout setting), and makes it the active
  layout.

### Changed

- **Duplicate** on a layout row now means the same thing everywhere: a copy of
  what is SAVED there. On the current layout that means its saved version
  _without_ the unsaved changes on top, and which layout is active does not
  change. Saving the live layout under a new name is the `+` above.
- A layout row's tools follow the Scratchpad's order — act, copy, edit, delete —
  so save-as and duplicate lead and rename sits beside delete.
