<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- Profiles can pick their own icon — any lucide glyph from a searchable grid — and any theme colour for it (Settings → Profile). The chosen glyph shows in the top-bar profile button and the profile picker, and recolours with light/dark. Named icons lazy-load so the bundle stays small. (protocol 7.4)
- **Scratchpad** (Phase 8): a per-profile bank of reusable prompts and notes, reached from the right sidebar's new Agent · Terminal · Scratchpad header. Each entry is project- or profile-scoped (project entries show only in their project; profile entries everywhere), drag-reorderable with newest on top, and filterable by tag or agent. Insert an entry into the focused terminal (bracketed paste, no submit) or copy it; create/edit inline. New `/api/scratchpad` endpoints and a `right_panel` ui-state key. (protocol 7.3)
- Symlinked directories are now explorable in the file tree: `/tree` resolves a symlink to its target kind, so a link to a directory expands and a link to a file opens. The link icon marks the symlink's own row while its children keep their normal icons. (protocol 7.2)

### Changed

- File routes now follow symlinks whose target lies outside the worktree (browse, open, and save through them), and terminal-link resolution does the same. The containment guard now rejects only lexical escapes (absolute paths and `..` above the root) rather than any symlink leaving the worktree — a symlink is a real object the user placed there, and puddle runs as that user. Following a link still reaches only its target subtree, never a sibling or parent outside it.
