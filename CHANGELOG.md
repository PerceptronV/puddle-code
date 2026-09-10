<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Fixed

- Paste clipboard images into the focused file-tree directory with timestamped screenshot names.
- Keep session shell history on its private file when directory, environment, or prompt hooks repoint `HISTFILE` at runtime.
- Make Option+Left/Right move by word in macOS terminals instead of inserting the unrecognised xterm sequence tail.
