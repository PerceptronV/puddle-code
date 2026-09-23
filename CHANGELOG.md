<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- Add an eye toggle for read-only mobile remote previews of Markdown, HTML with sandboxed JavaScript, images, audio, video and PDFs, including bounded local assets and custom browse roots (daemon/cockpit protocol 21.1).

### Fixed

- Retire deleted and replaced remote registrations from the relay, retry cleanup across outages/restarts, and expose confirmed removal of legacy phantom hosts in remote settings (daemon/cockpit protocol 21.0; encrypted remote protocol stays 2).

- Keep the current protocol assertion separate from schema tests and verify that older daemons require an upgrade.
