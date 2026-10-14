<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Fixed

- Align the shared API protocol assertion with protocol 22.4 so CI accepts the remote push notification changes.
- Publish the npm CLI through GitHub OIDC trusted publishing with a compatible npm version instead of relying on a stored publishing token.
