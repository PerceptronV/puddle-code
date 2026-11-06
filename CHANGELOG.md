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

- Add header host/profile context menus for renaming and colours, plus a Host updates shortcut.
- Fade the dashboard terminal and full-screen profile picker when opening and closing.

- Add custom project colours alongside the shared host/profile preset palette, with a stable grey default swatch.
- Animate sidebar accordions, workspace changes, new tabs, drag placement and inline Scratchpad/Layout forms while respecting reduced motion.

- Add an Appearance toggle to briefly show the host icon and name when returning to a cockpit window or browser tab.

- Show saved host names, colours and icons in the desktop New Puddle Window picker, including offline hosts.

- Choose custom profile colours and host accents with a colour picker seeded from the current selection.

- Restore individual files from Changes using a return-arrow action, with confirmation before discarding edits or deleting untracked files.

#### Fixed

- Dismiss the host identity overlay on any shortcut-key release and show opted-in focus reminders through native Mac window activation. Mac focus reminders appear instantly and fade out after 0.4 seconds without flashing back; debounce rapid activation signals. The reminder and held shortcut share smaller icon and text styling. Motion options sit at the bottom of Appearance.

- Keep tab fills and controls inside rounded pane edges. Increase pane-frame contrast against active tabs and editor content in both themes by adjusting accent lightness while retaining its hue and saturation.
- Forward native Mac Command key releases so letting go of `/` dismisses the host overlay while Command and Option remain held.
- Preview files with file-tree Up/Down and pin with Enter; keep repeated preview-slot browsing free of fades.

- Remove the border around the large host identity overlay shown with ⌘⌥/.

- Use one shared font size for collapsed project abbreviations, matching the smallest size needed to fit the rail.

- Align file and folder staging buttons with the Changes heading.

### Daemon

#### Changed

- Protocol 26.6: accept custom six-digit hex project colours alongside preset colours.

- Protocol 26.5: accept custom six-digit hex host accents alongside preset colours.

- Protocol 26.4: add per-file Git restore with explicit untracked-file deletion consent and preservation of staged changes.

#### Fixed

- Ignore Claude-owned background copies’ inherited hooks so native `/fork` cannot rebind the original Puddle terminal or change its turn status.
- Synchronise OpenCode 2.2.5+ native terminal selection, new/fork conversations and exact automated replies; discover both V1 and V2 SQLite histories without waiting on native database locks.

### Runtime

#### Fixed

- Recheck preparing owners promptly during launch while retaining recovery backoff for real failures and maintenance admission.
- Reuse bounded Claude and Gemini version observations across runtime launches, invalidating them when the executable or launch environment changes.
- Observe Codex app-server readiness sooner and fail promptly when its process cannot start or exits under a signal.
