<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Fixed

- Build and preflight Linux release tarballs with a C++20 toolchain while preserving the glibc 2.28 host floor, and exercise both release architectures before tagging.
- Open the command palette and dispatch other app shortcuts when Monaco has focus instead of letting the editor consume their key chords.
- Release the directory pin when returning from a parent-directory or command-palette browse to the worktree.
- Keep the terminal metadata rows compact with equal outer spacing and one matching gap between environment and port details.
