<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [0.0.36] — 2026-08-09

### Added

- Terminal file links (⌘/Ctrl+click) now work for absolute paths, `~` paths, and files outside the worktree — an outside file opens as an `external` editor tab, exactly as the browse tree opens one. A link to a **directory** binds the file tree to it as a pinned browse with the usual return-to-worktree button, surfacing the Files navigator. Protocol **15.2** (additive).

### Changed

- The desktop app checks for new releases every half hour (was every six hours), so the "Restart to update" toast lands the same morning a release ships.
