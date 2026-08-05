<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- **Next / previous tab in the focused pane**: ⌃⇥ and ⌃⇧⇥ in the desktop shell (⌃⌥] / ⌃⌥[ in a browser, which can never see ⌃⇥), cycling the strip in order and wrapping at both ends. Rebindable in Settings → Hotkeys like every other global shortcut, and deliberately not deferred to a focused terminal — switching away from the terminal you are typing in is the point.
- **Clicking a path locates the file in the Files tree**: a search hit (including the file-path heading over a run of content matches, which was the one path in the list you could not click), an uncommitted change, and a file inside a commit all expand the tree to the file, select it, and scroll it into view. The reveal is latched, so the sidebar stays on the results you are reading and the tree honours it the moment you open Files.

### Changed

- **A save the file's disk copy has moved under is now reconciled in place**: the editor shows the version on disk beside your buffer — read-only on the left, your still-editable text on the right — so you can take the hunks you want and save the result, instead of choosing blind between Reload (lose your edits) and Overwrite (lose the agent's). Both blunt answers remain as buttons, nothing is written by the refused save, and a save made after seeing the two expects the disk version, so a merge lands instead of colliding again.
- **A rendered preview keeps up with the file on disk**, not just with the buffer beside it: it polls while it is the visible tab and adopts anything newer while the buffer is clean, so a document an agent is writing renders as it goes. Previously the rendered view was built once from the first read and never moved again.
- **Every hover marquee now travels at one speed** rather than one duration. A fixed 900ms made a long path race past while a barely-clipped one crawled; the duration is now derived from the distance, so the same gesture reads the same everywhere.
- **Session rows hover-scroll** their title, branch, and agent line — an agent names its own sessions, so the title is both the most likely to be clipped and the reason you hover the row. Uncommitted-change rows, compacted directory rows, search results and a commit's changed files scroll too.
- **The Archived disclosure lists the newest conversation first**, by the same last-activity timestamp its rows show, and under a project-based layout it keeps to the current project — that mode is a window about one project, so another project's archived session offers nothing to do there.
- **The top bar is one height in every window state** (36px, down from 40 in the macOS desktop shell): entering full-screen no longer resizes the chrome, and the host name now EASES to the left edge as the traffic-light inset drops instead of jumping. The traffic lights move with the height, staying centred on the host name.
- **The top-right controls read as one cluster**: the gap between them is gone, since each already carries 9px of its own padding around a 14px glyph. Compact density is unchanged.

### Fixed

- **⌘S now saves from a preview tab** — and from any pane focused by its tab chip rather than by clicking into the text. The shortcut was bound inside Monaco alone, so a rendered markdown or HTML preview (which has no Monaco) could not save the buffer it was showing, and the keystroke fell through to the browser's Save Page dialogue.
- Double-clicking a tab no longer leaves its filename text-selected — that gesture pins the tab, and the browser's own word-select came along for the ride.
