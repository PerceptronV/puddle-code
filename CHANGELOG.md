<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- Keep the daemon attached to an SSH cockpit when a host reaps its detached `nohup` child, preserving host data and resumable session state across cockpit launches.

### Fixed

- Build Linux daemon releases against glibc 2.28 so they run on RHEL/Rocky 8, and revalidate existing install trees instead of accepting a failed partial installation.
