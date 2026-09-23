<!--
Archived release changelog. Governance lives in CLAUDE.md §"Changelog discipline".
-->

# Changelog

## [0.2.7] — 2026-09-23

### Changed

- Allow an empty project default base branch to follow the branch currently checked out at the clone location for each new agent or terminal; retain explicit branch choices (daemon/cockpit protocol 21.3; remote protocol remains 2).

### Fixed

- Fix CI deployment validation by creating a private temporary service environment file from the checked-in example before resolving the Compose configuration.
