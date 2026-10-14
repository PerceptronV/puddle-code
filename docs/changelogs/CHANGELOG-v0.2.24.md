<!--
Archived release changelog. Governance lives in CLAUDE.md §"Changelog discipline".
-->

# Changelog

## [0.2.24] — 2026-10-14

### Fixed

- macOS releases without signing secrets unset the empty certificate environment before ad-hoc packaging, preventing electron-builder from treating the desktop directory as a certificate file. Desktop packaging leaves publication to the release job.
