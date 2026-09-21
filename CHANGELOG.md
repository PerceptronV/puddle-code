<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- Add lightweight built-process and loopback OpenSSH authentication suites, with separate manual browser and desktop acceptance.

### Fixed

- Preserve browser login, terminal snapshots and refresh correlation across cockpit replacement and upstream recovery; retain desktop routes when the origin moves.

### Security

- Replace distributed master credentials with private host control, short-lived renewable connection leases and single-use browser invitations; migrate to protocol 18.0 and require existing tabs to run `puddle launch` once.
- Isolate forwarded applications on a separate loopback origin, bind proxy grants to browser authorisation and revoke active streams when their authority expires.
