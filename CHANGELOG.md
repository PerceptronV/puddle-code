<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Cockpit

#### Added

- Open projects in dedicated native windows, focus them through shared project navigation, and return their latest workspace after closing them even when no host window is open (application protocol 26.15; native OS acceptance remains in progress).
- Drag a dedicated project's sidebar label back to its host, or use its return menu, preserving drafts and closing project ownership atomically (application protocol 26.16).
- Open individual files and sessions in native pane windows from their existing context menus, and focus an existing detached view when reopening it (application protocol 26.9).
- Open an entire pane in its own native window from its tab-strip context menu, preserving dirty text through an acknowledged handoff (application protocol 26.8).
- Return detached panes to existing host/project windows through their context menu, preserving dirty text and view positions and retaining the source when late drafts remain (application protocol 26.11).
- Connect detached pane dragging to the acknowledged return handoff, validate host/profile identity and place the pane in the destination's visible project (application protocol 26.12; native OS acceptance remains in progress).
- Drag files, sessions and native tabs into existing pane windows through the same draft-preserving handoff, and keep filesystem/archive drag actions local to their source window (application protocol 26.13).
- Highlight TeX and LaTeX commands, comments, environments, mathematics and verbatim text, with automatic file detection and a per-file language choice.

#### Changed

- Show only the project name in workspace window titles and the active file or session name in detached pane titles.
- Coordinate native notification sounds/delivery and update offers across windows, retain notifications when their original window closes, and route clicks to the correct profile or detached session (application protocol 26.21).
- Save, duplicate and load native window arrangements through the host Layouts popover, including project saves from the dashboard; preserve mounted editors when saving and observe uncertain loads without redispatch.
- Coordinate native arrangement application with scoped window matching, draft-preserving plans, atomic ownership and cancellation recovery; retain each restored window's layout mode without changing client preferences (application protocol 26.20; native OS acceptance remains in progress).
- Stage native layout participants through the reused workspace/dashboard, verify mounted revisions and preserve drafts on cancellation (application protocol 26.19).
- Coordinate native layout capture across window checkpoints and prepare atomic multi-window recovery transactions with draft retention (application protocol 26.18).
- Prepare named native window layouts with portable arrangement storage, scoped capture projections and a single-tree browser fallback (application protocol 26.17).
- Support typing through Ripple when its divider covers the live input, reusing native keyboard, paste and IME handling with anchored cells and a visible caret. Preserve the default display-only split and native composer.

- Prepare project-window handoffs with durable return records and shared destination planning; subsequent controls use the same ownership flow (application protocol 26.14).
- Refresh the Puddle logo across the favicon, in-app branding, web app and notification icons, and macOS/Linux desktop icons.
- Separate native window lifetime from host connections and retain revisioned desktop working sets and acknowledged transfer records (application protocol 26.7).
- Flush desktop working sets and dirty drafts before native close or Command-Q, and cancel closure when a renderer cannot confirm its checkpoint.
- Preserve editor selections when detaching from project-based layouts by translating their saved view-state scope.
- Save native window drafts before reload or host refresh, serialise navigation per host, and let Command-Q wait for pending navigation (application protocol 26.10).

#### Fixed

- Keep unavailable native tabs and expose retained draft text for copying or downloading when a file, session or project disappears; preserve discard confirmation and restore editing after retry.
- Keep project and pane window titles identifiable when unrelated host sessions change status, and restore the current host title on leaving the workspace.
- Preserve the active editor on native window reload when the URL retains a previous session binding.
