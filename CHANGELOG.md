<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- "Open terminal in worktree" in the session lifecycle menu (expanded rows, collapsed dots, and tab right-click alike): spawns a terminal session sharing that session's working directory and lands in it.
- Reorder tabs within a pane's tab strip by drag: each chip and the strip's tail are drop targets resolving to an insertion index, marked by a live caret.
- Session status dots now show on terminal tabs from OTHER projects too — the tiling area labels its tabs against the daemon's full session list, not just the current project's.

### Changed

- **Breaking (protocol 7.0):** workspace ui_state is keyed by profile alone, not (project, profile) — the centre editor area is one surface shared across a profile's projects, so navigating between projects keeps the same layout tree. `GET/PUT /api/projects/:id/state` moved to `/api/profiles/:id/state`; the `project_states` table migrates to `profile_states` (each profile keeps its most recent snapshot), and cross-profile seeding is gone — a fresh profile starts with a fresh workspace.
- Dragging a tab into another pane now MOVES it — file tabs behave exactly like terminals, leaving nothing behind (previously an editor drop into a different pane duplicated the tab).
- A drag pins: dropping a preview (italic) tab anywhere promotes it to a permanent tab, as in VSCode.
- Session reordering in the right sidebar works in the cross-project view too (expanded rows and collapsed dots alike): drag within a project's group; the order persists profile-wide and a drag can never move a session between projects.

### Fixed

- Tab reordering within a pane's strip works again — a centre drop used to append to the end of the target strip regardless of where the tab was dropped.
- Reordering sessions in the right sidebar works again — it had been disabled whenever the cross-project sidebar (the default) was on.
