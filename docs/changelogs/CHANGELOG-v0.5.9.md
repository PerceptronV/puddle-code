<!--
Archived release changelog. Governance lives in CLAUDE.md §"Changelog discipline".
-->

# Changelog

## [0.5.9] — 2026-11-21

### Daemon

#### Fixed

- Keep new blank agent sessions temporary until native storage records a conversation, omit ended unsaved launches from history, and honour Codex, Claude Code, Gemini and OpenCode persistence differences.

### Runtime

#### Fixed

- Reuse identical anonymous terminal hyperlinks across agent redraws so repeated links do not exhaust screen retention and leave sessions blank or unavailable after switching projects or reloading.
