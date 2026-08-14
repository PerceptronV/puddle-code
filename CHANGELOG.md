<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- Add Monaco-style in-view find to rendered file previews and terminal sessions with case, whole-word, and regular-expression matching.

### Changed

- Restore the desktop's open cockpit windows after ordinary quits and restarts, not only upgrades.
- Reveal and expand worktree directories opened through the command palette in Files without pinning the sidebar.

### Fixed

- Bottom-align the macOS desktop window so its lower border launches flush with the work-area edge.
- Build Linux release tarballs with Python 3.11 on the glibc 2.28 image so node-gyp can compile native dependencies.
