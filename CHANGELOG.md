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

- Open individual files and sessions in native pane windows from their existing context menus, and focus an existing detached view when reopening it (application protocol 26.9).
- Open an entire pane in its own native window from its tab-strip context menu, preserving dirty text through an acknowledged handoff (application protocol 26.8).
- Return detached panes to existing host/project windows through their context menu, preserving dirty text and view positions and retaining the source when late drafts remain (application protocol 26.11).
- Connect detached pane dragging to the acknowledged return handoff, validate host/profile identity and place the pane in the destination's visible project (application protocol 26.12; native OS acceptance and project detachment remain in progress).
- Drag files, sessions and native tabs into existing pane windows through the same draft-preserving handoff, and keep filesystem/archive drag actions local to their source window (application protocol 26.13).
- Highlight TeX and LaTeX commands, comments, environments, mathematics and verbatim text, with automatic file detection and a per-file language choice.

#### Changed

- Support typing through Ripple when its divider covers the live input, reusing native keyboard, paste and IME handling with anchored cells and a visible caret. Preserve the default display-only split and native composer.

- Prepare project-window handoffs with durable return records and shared destination planning; project menus, redirects and native close integration remain in progress (application protocol 26.14).
- Refresh the Puddle logo across the favicon, in-app branding, web app and notification icons, and macOS/Linux desktop icons.
- Separate native window lifetime from host connections and retain revisioned desktop working sets and acknowledged transfer records (application protocol 26.7; detached-window controls are in progress).
- Flush desktop working sets and dirty drafts before native close or Command-Q, and cancel closure when a renderer cannot confirm its checkpoint.
- Preserve editor selections when detaching from project-based layouts by translating their saved view-state scope.
- Save native window drafts before reload or host refresh, serialise navigation per host, and let Command-Q wait for pending navigation (application protocol 26.10).
