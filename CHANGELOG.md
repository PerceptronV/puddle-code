<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- Two shortcuts, both rebindable in Settings → Hotkeys: **Close window** (⌘W in a
  browser, ⌘⇧W in the desktop shell) and **Reopen last closed tab** (⌃⌥T in a
  browser, ⌘⇧T in the desktop shell — the browser keeps ⌘⇧T for its own tabs). A
  reopened tab returns to the pane it was closed from, at its old position in
  that pane's strip, and belongs to the layout it was closed in: the profile-wide
  surface, or that project's own layout under project-based layout. A tab whose
  session has since been archived or deleted is not resurrected.

### Fixed

- Toggling project-based layout in Settings no longer blanks every open window.
  Splitting the shared tiling tree into per-project slices left every slice
  carrying the source tree's node ids, so unioning them back on the way out put
  several panes under ONE id — react-resizable-panels throws "Panel ids must be
  unique" during render, and with no error boundary the whole page came down in
  every window that loaded the snapshot. Shards now get fresh ids, the union
  deduplicates, and a snapshot already written with colliding ids is repaired
  when it loads (so an affected workspace fixes itself).

### Changed

- Desktop: File → Close Window still shows ⌘⇧W, but the key now reaches the
  renderer instead of the menu, so rebinding **Close window** in Settings →
  Hotkeys actually moves the shortcut. Clicking the menu item still closes.
