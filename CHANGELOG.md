<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- Support Claude Code, Codex, OpenCode and Gemini CLI in Puddlang with per-agent interactive or scripted execution, persisted mode selection, exact reply correlation and account-preserving native conversation resume (daemon protocol 23.1).

### Fixed

- Include the Puddlang runner and its imports in standalone daemon archives, with a release smoke test that executes a TypeScript programme using both `puddlang` and `zod`.
