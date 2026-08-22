<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [0.0.56] — 2026-08-22

### Added

- Synchronise native conversation catalogues, titles, parentage, cwd, and missing state into profile-safe project/worktree placements.
- Follow exact in-agent `/clear`, `/resume`, and `/fork` transitions while preserving frozen terminal history, shells, environment, and runtime ownership.
- Add additive lifecycle hooks for Claude Code and Gemini CLI, a managed OpenCode plugin, and a Codex app-server bridge with direct-launch fallback.

### Changed

- Store native conversations separately from immutable Puddle session placements and expose the joined identity through protocol 16.4.
- Refresh eligible conversation catalogues on project activation, using debounced filesystem watches, a five-minute safety sweep, and adaptive fallback polling.
- Keep missing native conversations visible, disable their resume action, and focus the existing placement when a conversation is already live elsewhere.
