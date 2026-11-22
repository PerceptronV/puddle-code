<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Daemon

#### Fixed

- Keep new blank agent sessions temporary until native storage records a conversation, omit ended unsaved launches from history, and honour Codex, Claude Code, Gemini and OpenCode persistence differences.

### Runtime

#### Fixed

- Reuse identical anonymous terminal hyperlinks across agent redraws so repeated links do not exhaust screen retention and leave sessions blank or unavailable after switching projects or reloading.
