<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- "App shortcuts in terminals" (Settings → Sessions, per-browser, default on): chords bound to puddle actions — ⌃⇥/⌃⇧⇥ tab cycling, ⌘K, sidebar toggles — now work while a terminal is focused, instead of being eaten by xterm and sent to the agent. Turn it off to hand those keys back to terminal apps; terminal-owned keys (⌃A, ⌃`) go to the terminal either way.

### Fixed

- Auto-theming agents (e.g. Claude Code with `theme: auto`) no longer come up dark under a light puddle theme: they sample the terminal background at spawn, usually before any viewer has attached, so the browser-side answer to their OSC 10/11 colour query arrived for nobody. The daemon now answers those queries itself, from the colours the client reports over the WS on connect and on every theme switch (protocol 14.1, additive — against an older daemon the viewer-side answering remains). A running agent that already sampled keeps its choice until its next start/resume.
