<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- Add confirmed registration deletion to desktop Remote access settings, with browser revocation and local/SSH-only control (daemon/cockpit protocol 19.1; remote protocol remains 2).

### Fixed

- Initialise remote service volumes with private directory permissions to prevent startup failures and ingress 502 responses.
