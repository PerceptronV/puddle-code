<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Changed

- Label mobile terminal modifiers with the Mac symbols ⌃, ⌥ and ⇧ while retaining accessible names and pressed-state highlighting.

### Fixed

- Close terminal and agent session panels after archiving from their tab controls, even when the archive update arrives before the request completes.

- Add a one-shot Shift key to the mobile terminal strip and preserve Ctrl/Opt/Shift combinations for application-mode arrows, Shift+Tab, Shift+Enter and Escape.

- Open forwarded applications from desktop terminal links and port chips using an application-scoped invitation, so the system browser does not require a separate Puddle login.
