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
- Open an entire pane in its own native window from its tab-strip context menu, preserving dirty text through an acknowledged handoff (application protocol 26.8; project detachment and docking remain in progress).
- Highlight TeX and LaTeX commands, comments, environments, mathematics and verbatim text, with automatic file detection and a per-file language choice.

#### Changed

- Separate native window lifetime from host connections and retain revisioned desktop working sets and acknowledged transfer records (application protocol 26.7; detached-window controls are in progress).
- Flush desktop working sets and dirty drafts before native close or Command-Q, and cancel closure when a renderer cannot confirm its checkpoint.
- Preserve editor selections when detaching from project-based layouts by translating their saved view-state scope.
