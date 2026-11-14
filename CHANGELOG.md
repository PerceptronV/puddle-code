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

- Prevent an uncaught abort error when a host connection closes while its SSH control channel is still opening.
- Keep SSH password and 2FA prompts stable during reconnection by preventing competing background authentication and cancelling pending authentication when refreshing the connection.
