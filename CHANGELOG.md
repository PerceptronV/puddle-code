<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Fixed

- Preserve Codex and OpenCode conversations across daemon restarts by capturing only newly minted top-level agent session refs, repairing legacy refs by creation time, and preventing duplicate `(account, ref)` mappings.
