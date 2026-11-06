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

- Show saved host names, colours and icons in the desktop New Puddle Window picker, including offline hosts.

- Choose custom profile colours and host accents with a colour picker seeded from the current selection.

- Restore individual files from Changes using a return-arrow action, with confirmation before discarding edits or deleting untracked files.

#### Fixed

- Use one shared font size for collapsed project abbreviations, matching the smallest size needed to fit the rail.

- Align file and folder staging buttons with the Changes heading.

### Daemon

#### Changed

- Protocol 26.5: accept custom six-digit hex host accents alongside preset colours.

- Protocol 26.4: add per-file Git restore with explicit untracked-file deletion consent and preservation of staged changes.

#### Fixed

- Ignore Claude-owned background copies’ inherited hooks so native `/fork` cannot rebind the original Puddle terminal or change its turn status.
- Synchronise OpenCode 2.2.5+ native terminal selection, new/fork conversations and exact automated replies; discover both V1 and V2 SQLite histories without waiting on native database locks.

### Runtime

#### Fixed

- Recheck preparing owners promptly during launch while retaining recovery backoff for real failures and maintenance admission.
- Reuse bounded Gemini version observations across runtime launches, invalidating them when the executable or launch environment changes.
- Observe Codex app-server readiness sooner and fail promptly when its process cannot start or exits under a signal.
