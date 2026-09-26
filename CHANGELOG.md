<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- Offer Download when holding a mobile file row, preserving filenames and bytes with the existing 8 MiB remote file limit.

### Fixed

- Render mobile PDF previews from fetched bytes without a blob request blocked by the deployed security policy.
- Keep mobile switches horizontal while preserving their larger touch targets.
- Format the daemon protocol in `puddle --version` as `22.0c3`, joining the connector suffix without a hyphen.
