<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Fixed

- Toggling project-based layout in Settings no longer blanks every open window.
  Splitting the shared tiling tree into per-project slices left every slice
  carrying the source tree's node ids, so unioning them back on the way out put
  several panes under ONE id — react-resizable-panels throws "Panel ids must be
  unique" during render, and with no error boundary the whole page came down in
  every window that loaded the snapshot. Shards now get fresh ids, the union
  deduplicates, and a snapshot already written with colliding ids is repaired
  when it loads (so an affected workspace fixes itself).
