<!--
Archived release changelog. Governance lives in CLAUDE.md §"Changelog discipline".
-->

# Changelog

## [0.3.1] — 2026-10-14

### Changed

- Rename the puddlang executable to `pudl` across npm, standalone installers and command examples; retain the puddlang language/API name.
- Suppress desktop notifications only during recent typing, pasting or clicking in the notifying session when focused delivery is disabled; idle windows and other sessions no longer silence alerts.

### Fixed

- Activate the exact session tab on desktop notification clicks, including when a file hides its terminal under the same URL, and open sessions without an existing tab.
