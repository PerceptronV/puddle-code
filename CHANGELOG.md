<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Changed

- Show desktop notifications with host/project, session title and message preview in that order: native text fields on macOS and Windows, and a separate session line above the preview on Linux (protocol 24.1; browsers retain their existing layout).

### Fixed

- Attach desktop SSH authentication prompts to their host's window, display the target explicitly, and discard pending and late requests when that host closes while retaining at most one request per host.
