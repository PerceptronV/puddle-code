<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Fixed

- Browsing to the top of the file tree no longer reports "path escapes the worktree" for every entry. Walking up to the filesystem root left the containment check comparing paths against `//`, so nothing under `/` could be listed, opened, or saved — expanding `Users` failed even though the browse root explicitly allowed it. Reading and editing files anywhere above the worktree now works, and genuine escapes are still refused.
