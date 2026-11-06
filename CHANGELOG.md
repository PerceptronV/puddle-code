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

- Restore individual files from Changes using a return-arrow action, with confirmation before discarding edits or deleting untracked files.

#### Fixed

- Use one shared font size for collapsed project abbreviations, matching the smallest size needed to fit the rail.

- Align file and folder staging buttons with the Changes heading.

### Daemon

#### Changed

- Protocol 26.4: add per-file Git restore with explicit untracked-file deletion consent and preservation of staged changes.

#### Fixed

- Ignore Claude-owned background copies’ inherited hooks so native `/fork` cannot rebind the original Puddle terminal or change its turn status.
