<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Fixed

- Replace stale desktop SSH authentication prompts per host during background retries, and close prompts when their requesting SSH process exits.

- Allow agent and terminal sessions to share a local repository's current branch before its first commit, without requiring a remote.
