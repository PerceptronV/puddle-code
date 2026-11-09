<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Frontend

#### Fixed

- Retry transient desktop packaging downloads up to three times while preserving checksum, signing and publication checks.
- Refresh the bundled Huddle executable test kit to match the current SDK and component contracts.

### Daemon

#### Fixed

- Restore CI coverage for older host and Huddle capabilities, coordinated upgrades and calibrated runtime resource measurements.
