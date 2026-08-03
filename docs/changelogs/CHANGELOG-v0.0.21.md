<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [0.0.21] — 2026-08-03

### Added

- Add an independent Monaco editor font-size control in Appearance; changing it does not change terminal text.
- Offer “Open Terminal in Directory” when right-clicking empty space in the explorer, opening a terminal at the worktree root (it was previously only on folder rows).

### Changed

- Keep every non-archived project visible in the right session sidebar, including projects with no sessions, so a project stays a navigation target: expanded groups get clickable project-name headers, and the collapsed rail gains a five-character project label above each divider.
- Show the session's agent or terminal glyph on the collapsed rail instead of a bare status dot, matching the expanded rows and tab chips.
- Name the agent (or `terminal`) on every sidebar row's second line, with the account appended after a `·` when there is one — previously the line appeared only for agent sessions with an account.

### Fixed

- Let `puddle upgrade desktop` install the latest macOS app when no existing Puddle bundle is present, choosing writable `/Applications` or falling back to `~/Applications` and no longer requiring an old bundle to swap aside.
- Tighten adjacent captured-environment and ports rows beneath a terminal pane.
