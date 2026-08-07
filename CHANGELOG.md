<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Fixed

- Switching (or creating) a profile now lands on that profile's dashboard. The picker replaced the router without touching the address, so the previous profile's project URL was still current when the router came back — and a project route binds the workspace to the project's OWNING profile, so a brand-new profile appeared to have inherited the old profile's projects, sessions, and layout wholesale.
