<!--
Archived release changelog. Governance lives in CLAUDE.md §"Changelog discipline".
-->

# Changelog

## [0.2.14] — 2026-09-26

### Added

- Offer Download when holding a mobile file row, preserving filenames and bytes with the existing 8 MiB remote file limit.

### Fixed

- Render mobile PDF previews from fetched bytes without a blob request blocked by the deployed security policy.
- Keep mobile switches horizontal while preserving their larger touch targets.
- Format the daemon protocol in `puddle --version` as `22.0c3`, joining the connector suffix without a hyphen.
