<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [0.2.1] — 2026-09-21

### Fixed

- Fix daemon and cockpit startup on legacy installations by migrating owned Puddle homes from `0755` to `0700`, and create fresh installer homes privately.
- Fix self-hosted application builds with filtered dependencies by separating the production Vite configuration from the development cockpit gateway.
- Fix remote container builds and static file serving from checkouts with private file permissions.
- Remove Caddy's unused privileged-port capability so the application container starts with all capabilities dropped.
