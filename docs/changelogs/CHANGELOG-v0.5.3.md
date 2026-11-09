<!--
Archived release changelog. Governance lives in CLAUDE.md §"Changelog discipline".
-->

# Changelog

## [0.5.3] — 2026-11-09

### Frontend

#### Changed

- Include the changes prepared for [v0.5.1](https://github.com/PerceptronV/puddle-code/blob/v0.5.3/docs/changelogs/CHANGELOG-v0.5.1.md) and [v0.5.2](https://github.com/PerceptronV/puddle-code/blob/v0.5.3/docs/changelogs/CHANGELOG-v0.5.2.md), whose release assets were not published.

#### Fixed

- Verify Electron downloads against the official checksums in its locked npm package, avoiding repeated GitHub checksum-download timeouts during desktop packaging.

### Daemon

#### Fixed

- Make private runtime fixtures independent of the host umask, wait for uncontended pre-launch admission, and end the owner first when testing crash recovery.
