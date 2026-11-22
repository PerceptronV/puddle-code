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

- Show current runtime takeover blockers during host recovery and explain verification, continuation and separate session interruption.

### Daemon

#### Fixed

- Block daemon replacement when existing runtimes report unsaved state, expose bounded recovery diagnostics through existing update reviews, and show affected runtime ids in CLI status without relaxing completion checks or replaying actions.
