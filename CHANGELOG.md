<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Changed

- Dragging a file from the sidebar into the tiling area now OPENS it at the drop position instead of moving an existing tab of it: a file already open elsewhere gains a second tab sharing the same buffer, and edge-dropping a pane's only file onto its own edge splits the pane with the file on both sides (impossible under move semantics, which first removed the tab and collapsed the split to a no-op). Within one pane a file stays unique — dropping it into a pane that already shows it just focuses that tab. Dragging a tab chip still moves it, and session tabs (one live PTY each) always move.

### Fixed

- Terminals no longer sometimes come back in the wrong typeface after a reload: xterm measures its glyphs once at creation, so a terminal mounted before the `Ubuntu Sans Mono` webfont finished loading measured — and kept — the fallback mono. Terminal creation now waits for the face (instant once cached; the attach replay repaints, so nothing is lost).
- A clipped name in the files tree can be read again: hovering its row now eases the full name into view (the marquee treatment every other sidebar list gives clipped text, at the app's one speed, files and folders alike). The v0.0.28 attempt — a native `title` tooltip on folder rows — never appeared, because Chromium suppresses title tooltips on draggable elements and every tree row is a drag source.
