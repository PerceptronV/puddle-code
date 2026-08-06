<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Fixed

- Clicking an OSC 8 hyperlink in a terminal (how Claude Code prints URLs, e.g. the login OAuth link) no longer falls through to xterm's built-in handler — a native "this link could potentially be dangerous" confirm() that then opened a blank window the desktop shell refused, so accepting it opened nothing. OSC 8 links now open through the same path as plain-text links: no dialogue, real URL, SSH-mode localhost rewriting included.
