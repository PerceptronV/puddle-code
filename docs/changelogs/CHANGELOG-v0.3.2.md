<!--
Archived release changelog. Governance lives in CLAUDE.md §"Changelog discipline".
-->

# Changelog

## [0.3.2] — 2026-10-14

### Added

- Support Claude Code, Codex, OpenCode and Gemini CLI in Puddlang with per-agent interactive or headless execution, persisted mode selection, exact reply correlation and account-preserving native conversation resume (daemon protocol 24.0).

### Changed

- Rename Puddlang's `scripted` execution mode to `headless` across spawn options, session state, agent modules, examples and documentation; migrate existing placements and advance daemon protocol to 24.0 and remote protocol to 4.

### Fixed

- Include the Puddlang runner and its imports in standalone daemon archives, with a release smoke test that executes a TypeScript programme using both `puddlang` and `zod`.
