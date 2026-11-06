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

- Unify accented editor and terminal backgrounds with sidebar surfaces, using a slightly deeper light tint and lighter dark tint while preserving tab contrast and the default theme.
- Keep existing-tab and pane activation immediate without fading tabs or content, including across projects in a shared layout.
- Preserve the content fade when closing the active tab while keeping ordinary tab switches immediate.

### Daemon

#### Fixed

- Automatically repair legacy supervisor marker write permissions during authorised daemon-update staging after checking ownership, unchanged file identity and the live service; keep status and preflight read-only and retain specific blockers and manual repair guidance when automatic repair is unsafe.
