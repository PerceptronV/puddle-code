<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Changed

- Simplify Puddle Remote home to collapsible host/project groups, add its brand mark, compact the session rail, and hide revoked browsers in mobile and desktop settings.
- Support long-press-and-drag text selection with a shared Copy action in mobile terminals and file content.
- Compact the mobile workspace header, switch sessions from the shared title dropdown, follow desktop project/session ordering, and combine file navigation into one toolbar.
- Replace the mobile keyboard button with an image picker that shares desktop image paste, inserts without submitting, and resizes large photos to fit remote request limits.

### Fixed

- Prefill mobile path browsing with the current directory or file and resolve both file and directory paths before navigating.
- Keep mobile swipes inside terminal history and agent interfaces, preserve tap-to-type, and prevent terminal, file and session scrolling from moving the surrounding page.
