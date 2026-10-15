<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Changed

- Show macOS desktop notifications with the host and project on the first line, the session title below, and the message preview in the body (protocol 24.1; other clients retain their existing layout).

### Fixed

- Attach desktop SSH authentication prompts to their host's window, display the target explicitly, and discard pending and late requests when that host closes while retaining at most one request per host.
