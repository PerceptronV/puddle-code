<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [0.0.49] — 2026-08-14

### Fixed

- Keep Codex and OpenCode session creation responsive with large imported histories by moving native-ref discovery off synchronous filesystem scans and caching unchanged metadata.
- Keep high-output agent terminals responsive and visible by batching PTY redraws to browser frames and using xterm's stable built-in renderer.
- Preserve terminal history through `tqdm`-style progress output by raising the scrollback default from 5,000 to 20,000 lines and migrating the old default.
