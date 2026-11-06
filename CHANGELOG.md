<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Cockpit

#### Added

- Add Linux arm64 AppImage releases, built on a native arm64 runner alongside Linux x64 and macOS arm64. Linux packaging verifies extraction, bundled application contents and executable architecture before publication.

#### Fixed

- Keep existing-tab and pane activation immediate without fading tabs or content, including across projects in a shared layout.
- Preserve the content fade when closing the active tab while keeping ordinary tab switches immediate.

### Daemon

#### Fixed

- Identify legacy supervisor markers with group/other write permissions as a specific upgrade blocker and provide explicit host-side permission repair guidance in the CLI; keep inspection read-only and require fresh service checks after repair.
