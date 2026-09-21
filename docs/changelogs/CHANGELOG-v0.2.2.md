<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [0.2.2] — 2026-09-21

### Added

- Add a five-minute browser-approved account registration handoff with one-use private verifiers, origin checks and replay protection (daemon/cockpit protocol 20.0; encrypted remote protocol remains 2).
- Add confirmed registration deletion to desktop Remote access settings, with browser revocation and local/SSH-only control (daemon/cockpit protocol 19.1; remote protocol remains 2).

### Changed

- Distil remote access into Puddle’s shared project cards and dialogues, with host-grouped projects, host disconnection in settings, a compact session rail, Files/Terminals views, custom-path browsing and direct terminal typing with touch keys.
- Render pairing QR codes as sharp SVGs with rounded white surfaces and Puddle foreground ink, and match pairing links to the theme's text colour.
- Start remote registration from desktop browser sign-in, with editable default origins and in-place connection settings instead of a second form or copied registration code.
- Combine remote access and settings sync under Remote & Sync, preserving existing settings links.
- Replace native disclosure triangles throughout the UI with Puddle chevrons.

### Fixed

- Keep remote status polling quiet so controls, registration fields and button labels no longer blink during background refreshes.
- Initialise remote service volumes with private directory permissions to prevent startup failures and ingress 502 responses.
