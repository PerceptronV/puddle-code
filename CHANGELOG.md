<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- Support Claude Code, Codex, OpenCode and Gemini CLI in Puddlang with per-agent interactive or headless execution, persisted mode selection, exact reply correlation and account-preserving native conversation resume (daemon protocol 24.0).

### Changed

- Rename Puddlang's `scripted` execution mode to `headless` across spawn options, session state, agent modules, examples and documentation; migrate existing placements and advance daemon protocol to 24.0 and remote protocol to 4.

### Fixed

- Include the Puddlang runner and its imports in standalone daemon archives, with a release smoke test that executes a TypeScript programme using both `puddlang` and `zod`.
