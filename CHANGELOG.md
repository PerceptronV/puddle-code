<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- New untitled file hotkey (`tab.newUntitled`, Settings → Hotkeys): ⌃⌥N on the web, plain ⌘N in the desktop shell — the keyboard route to double-clicking a tab strip's blank tail. The desktop menu's New Window moved from ⌘N to ⇧⌘N to yield the key.

### Fixed

- Untitled drafts now follow the editor word-wrap setting (and the ⌥Z toggle) like every other editor, instead of never wrapping.
