<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Fixed

- Keep LaTeX build intermediates and generated previews in each source root's local `.puddle/latex` directory rather than the daemon's global state directory.
- Serve bundled `.mjs` assets as JavaScript so generated LaTeX PDFs load their lazy PDF.js worker.
