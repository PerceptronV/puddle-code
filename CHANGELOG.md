<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- Symlinked directories are now explorable in the file tree: `/tree` resolves a symlink to its target kind, so a link to a directory expands and a link to a file opens. The link icon marks the symlink's own row while its children keep their normal icons. (protocol 7.2)

### Changed

- File routes now follow symlinks whose target lies outside the worktree (browse, open, and save through them), and terminal-link resolution does the same. The containment guard now rejects only lexical escapes (absolute paths and `..` above the root) rather than any symlink leaving the worktree — a symlink is a real object the user placed there, and puddle runs as that user. Following a link still reaches only its target subtree, never a sibling or parent outside it.
