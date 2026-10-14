<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Changed

- Agent notifications show the conversation name and a bounded snippet of its last output. Mobile background previews are encrypted between the approved host and device, with generic alerts retained for older hosts/services.

### Fixed

- Clicking a notification opens its exact session on desktop, web and mobile, including after a renderer reload or a cold Home Screen launch. Login preserves the destination; unavailable sessions no longer open an unrelated conversation.
