<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- The file tree can now walk above the worktree: a `..` row enters a browse of parent directories (auto-pinning the sidebar so it stays put), and files open as fully editable tabs — drafts, dirty dots, conflict-safe saves, and cross-window sync all work outside the worktree, keyed by the file's absolute location. The browse tree itself stays mutation-free (no rename/delete out there). Protocol 10.2/10.4: optional `root=` on the worktree file routes.
- The new-project dialog gains a "browse…" folder picker that walks the daemon host's directories graphically (git repositories flagged, chosen on click) — works identically over SSH, unlike an OS file dialog.
- Double-clicking the blank tail of a pane's tab strip opens a fresh untitled draft — worktree-agnostic, held in the profile's untitled store and persisted while you type; ⌘S opens a save-as dialogue that places it into the bound worktree, and closing the tab discards it (confirmed first). Protocol 10.3.
- Desktop app: File → Refresh Connection (⌘⌥R) restarts the focused window's cockpit — the same stop-and-reconnect as the UI's connection banner, reachable even when the page is wedged.
- Narrow-viewport (phone) workspace layout: below 768px the sidebars open as overlays from their rails instead of crushing the terminal, dismissing on backdrop tap or navigation; hover-revealed controls (tab closes, row menus, card actions) are always visible on touch devices.

### Fixed

- Returning to a session could leave the terminal unable to scroll (typing still worked) until a reload: a viewport sync that fired while the tab's DOM was parked latched the scroll range at zero height, and returning to an unchanged pane size never re-synced it. Re-attaching now forces the sync.

- Part of the terminal (typically the bottom half) could go blank after a resize until a selection forced a repaint: the terminal now repaints in full after every geometry change and renderer swap.
- The collapsed session rail's tooltips opened upward, covering the dots above; they now open to the left, and a dot's tooltip additionally shows the session's agent type and account.
- The editor find widget's close button could not be clicked: Monaco 0.55's button tooltips render inside the editor container, and for the rightmost button the label wrapped into a box tall enough to cover the button and swallow its clicks. Tooltips are now single-line and click-transparent.
- Waiting-input notifications silently never fired for browsers that had not granted permission: the desktop toggle defaults to on but the permission prompt only ever ran on a toggle click. The Notifications settings row now shows the live permission state (unrequested, blocked, or unsupported) with an inline request link.
- Waiting-input notifications were dropped when the session was in no cached query list (e.g. a tab parked on the dashboard); delivery now falls back to fetching the session list.

### Changed

- The file tree fully honours a multi-selection: dragging a selected row moves the whole selection (with an "N items" drag chip), and Download and Copy (Relative) Path act on every selected entry — like cut/copy/delete already did. A selection holding a folder and its descendants is pruned to the folder before acting.
- The Files header sheds its New File / New Folder buttons — creation lives in the tree's context menus (right-click a folder or empty space), leaving the header cluster at Refresh · Collapse Folders.
- Highlighting text in a terminal no longer auto-copies it: an agent's selection-copy (OSC 52) is held back until the copy chord — ⌘C on Mac, Ctrl+Shift+C elsewhere — commits it, matching how a local selection copies.
- Swap the session status colours: a running agent now shows amber (work in motion) and one awaiting input shows green (ready for you), in both themes. Git badges, sign-in states, and caution copy move to new `--success`/`--warning` tokens so they keep their conventional green/amber hues.
