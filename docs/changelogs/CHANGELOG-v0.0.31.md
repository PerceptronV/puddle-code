<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [0.0.31] — 2026-08-06

### Fixed

- Files opened from outside the worktree (browse-tree `external` tabs) now get the rendered markdown/HTML preview: the source ⇄ preview toggle appears on their tabs, the preview reads the same rooted buffer the source editor edits (live, unsaved edits included), asset references resolve against the browse root, and a ⌘-clicked link inside such a preview opens its target against that root rather than the worktree.
- Moving one tab of a file open in two panes no longer takes the other pane's tab with it (collapsing both into the drop target): a move now removes the tab from its source pane only — duplicated tabs are independent, and the tree-wide removal was a self-heal for the pre-v0.0.30 era when duplicates were illegal.

### Changed

- The collapsed rail's session glyphs settle at 16px marks (12px in compact density) at 0.75× stroke weight — v0.0.30's 24px filled the chip but read too heavy at rail width, and strokes scale with the box, so marks drawn for 12px rows rasterise visibly heavier when enlarged (the filled Gemini mark has no stroke to thin). Unlike the pre-v0.0.30 rail, the mark full-bleeds its box instead of floating a 12px icon in a 16px one.
