<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- Add repository-aware source control for owning repositories, ignored nested repositories, and recursive submodules, with staging, commits, and remote operations.
- Add live Monaco editor gutter indicators for lines added, modified, or deleted since the owning repository's current HEAD.

### Changed

- Extend staged and unstaged diff tabs to compare HEAD, index, and working-tree content independently, and bump the protocol to 15.3.
- Offer stale-save reconciliation through a dismissable Compare notification, re-offer it when the unresolved file is focused again, and lock every view of the shared buffer until its Monaco comparison has loaded.
