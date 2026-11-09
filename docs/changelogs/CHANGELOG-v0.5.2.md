<!--
Archived release changelog. Governance lives in CLAUDE.md §"Changelog discipline".
-->

# Changelog

## [0.5.2] — 2026-11-09

### Frontend

#### Changed

- Include the Huddle improvements prepared for [v0.5.1](https://github.com/PerceptronV/puddle-code/blob/v0.5.2/docs/changelogs/CHANGELOG-v0.5.1.md), whose release assets were not published.

#### Fixed

- Retry transient desktop packaging downloads up to three times while preserving checksum, signing and publication checks.
- Refresh the bundled Huddle executable test kit to match the current SDK and component contracts.

### Daemon

#### Fixed

- Restore CI coverage for older host and Huddle capabilities, coordinated upgrades and calibrated runtime resource measurements.
