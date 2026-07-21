<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- **Settings → Sync**: export a profile's machine-agnostic settings (Appearance, Profile glyph, Sessions, Editor, Hotkeys — never accounts, repos, or paths) as one opaque string and import it on another machine, updating only the fields it carries. A collapsible checklist chooses what to include; the string is gzip+base64 with a CRC-32 integrity check and a random Caesar shuffle (decoded via the known gzip `H` prefix).
- Customisable **keyboard shortcuts** (Settings → Hotkeys), stored per profile. Rebind the global/layout actions — command palette, close tab (⌃⌥W), toggle left/right sidebar (⌥⌘, / ⌥⌘.), open a navigator (⌥⌘E/F/V/B), new agent (⌃⌥\`), new terminal (⌃\`), toggle Scratchpad (⌥⌘S), editor save/word-wrap — with a key recorder, reset-to-default, and conflict + browser-reserved warnings. Filetree and terminal line-edit keys stay fixed. (protocol 7.6)
- The session lifecycle menu gains "Spawn agent in worktree" — a submenu of the profile's logged-in accounts (the default account first, so opening it and pressing Enter spawns the default) that starts an agent joining the session's existing worktree, alongside the existing "Open terminal in worktree".
- The homescreen gains two action tiles in the projects grid: "Open project" (the new-project dialogue) and "Open terminal" — a shell at `~` on the daemon host in a heading-less bottom pane that exists only on the homescreen, for cloning repositories before opening them as projects. One shell at a time: while it lives, opening reattaches to it (the tile reads "Close terminal", which ends it). Protocol 7.5: the `home` PTY stream and the `kill-shell` WS message.
- Storm-navy is now a profile icon colour (the theme-aware primary ink — navy in light, near-white in dark).

### Changed

- Protocol bumped to **8.0** (a deliberate major bump with no schema change) so every connected daemon hits a major mismatch on the next handshake and auto-upgrades onto this build, picking up the accumulated 7.x daemon-side changes.
- The profile icon picker is now a small curated set of ~60 lucide glyphs in a simple grid, all statically imported — no lazy-loaded per-icon chunks, no search, no scroll. This replaces the full searchable set, which relied on lazy chunks that could 404 behind a stale shell and never scrolled reliably in the popover.
- The profile icon "Default" now renders a neutral grey glyph rather than the navy heading ink (navy is its own explicit swatch), and the near-duplicate amber and accent swatches were dropped from the picker.
- Scratchpad entries drag from anywhere on the row (the grip handle is gone, reclaiming the left gutter), and editing now happens in a modal opened by clicking the row (or the `+`/pencil) rather than expanding inline.
- Deleting a Scratchpad entry now asks for confirmation inline — a warning line with Delete/Cancel — instead of removing it on the first click, since there is no undo.
