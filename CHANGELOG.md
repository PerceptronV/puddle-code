<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- **A crash no longer blanks the window.** React unmounts any tree it cannot
  render, so an exception left a white page with no message and no way back —
  which is what made the v0.0.22 and v0.0.23 bugs look catastrophic. There is now
  an error boundary around the routed view (a crash there leaves the top bar
  alive, and navigating away clears it without a reload) and another at the root.
  It names what stopped rendering, shows the error, says that sessions and
  worktrees are safe on the daemon, and offers Try again / Reload — while still
  logging the error and component stack to the console.
- **Double-clicking the host label or the profile name in the top bar renames it
  in place** — the same two fields Settings offers, without opening Settings.
  Clearing the host label unsets it, so it falls back to the machine's hostname.
- Right-clicking a project in the session sidebar can now edit its label:
  **Change project name** on the expanded header, **Change project abbreviation**
  on the collapsed rail. Both open the same in-place editor a double-click has
  always opened — which was the only way to find it.
- A **`+`** in the Layouts header, where the Scratchpad's is: it opens the same
  name field an unsaved layout shows, saves the **live** layout under that name
  (provenance from the project-based-layout setting), and makes it the active
  layout.

### Changed

- Results in **Changes, History, and Search** now open as **preview tabs** on a
  single click — italic, reusing one slot, replaced by the next peek — and pin on
  a double click, exactly as the files tree has always behaved. Scanning a result
  list used to leave a permanent tab behind for every row you looked at.
- **Duplicate** on a layout row now means the same thing everywhere: a copy of
  what is SAVED there. On the current layout that means its saved version
  _without_ the unsaved changes on top, and which layout is active does not
  change. Saving the live layout under a new name is the `+` above.
- A layout row's tools follow the Scratchpad's order — act, copy, edit, delete —
  so save-as and duplicate lead and rename sits beside delete.
