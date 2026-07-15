<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Fixed

- The CLI build wipes `dist/` before bundling, so the published npm package can no longer pick up leftovers from earlier builds (v0.0.1 shipped three stray tsc artefacts from the pre-Phase-6 stub this way); the `bin` path is normalised to the form npm was auto-correcting at publish time. No protocol change.
