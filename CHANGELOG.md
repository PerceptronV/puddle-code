<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Fixed

- A clipped name in the files tree can be read again: hovering its row now eases the full name into view (the marquee treatment every other sidebar list gives clipped text, at the app's one speed, files and folders alike). The v0.0.28 attempt — a native `title` tooltip on folder rows — never appeared, because Chromium suppresses title tooltips on draggable elements and every tree row is a drag source.
