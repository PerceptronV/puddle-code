<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Fixed

- Place notebook input prompts inside the executing cell's output with Enter submission, Ctrl+C interruption and fresh input state for each prompt.
- Label unsupported interactive Jupyter widgets explicitly and preserve their plain-text fallback.

