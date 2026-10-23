<!--
Archived release changelog. Governance lives in CLAUDE.md §"Changelog discipline".
-->

# Changelog

## [0.3.6] — 2026-10-23

### Fixed

- Reuse installed Node headers during CI and release dependency installation so native builds can recover from prebuilt-addon download failures without a second network request.
- Normalise ANSI colours in programme-terminal test assertions so coloured Node output does not fail CI.
