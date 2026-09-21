<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- Add Settings → Remote access in local and SSH desktop cockpits for enablement, status, QR/link pairing, browser approval/revocation, disablement and host identity recovery; add authenticated cockpit controls in protocol 18.1.
- Add self-hosted mobile access with email/Google/GitHub login, optional authenticator MFA, independently supervised host connectors and QR/link browser pairing.
- Add a single-terminal phone view, native multiline prompt composer, visible terminal keys and read-only text/change review without rewriting desktop layouts.
- Add remote administration and recovery commands, deployment images and isolated relay/browser acceptance suites.

- Add lightweight built-process and loopback OpenSSH authentication suites, with separate manual browser and desktop acceptance.

### Fixed

- Reject incomplete remote-origin input without throwing during registration form rendering.
- Preserve browser login, terminal snapshots and refresh correlation across cockpit replacement and upstream recovery; retain desktop routes when the origin moves.

### Security

- Require exact browser approval at the host, pinned Noise XX transport, bounded forwarding and fresh browser participation in the existing host leases; keep remote protocol 1 independent of daemon protocol 18.0.
- Persist device revocation and offline remote disable, isolate application delivery from the relay origin, and deny unreviewed remote routes and executable previews.

- Replace distributed master credentials with private host control, short-lived renewable connection leases and single-use browser invitations; migrate to protocol 18.0 and require existing tabs to run `puddle launch` once.
- Isolate forwarded applications on a separate loopback origin, bind proxy grants to browser authorisation and revoke active streams when their authority expires.
