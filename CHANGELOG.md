<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Fixed

- Recover legacy Codex chats directly from their rollout and creation time even when the old remote bridge recorded `~` as cwd or Codex has not yet restored the chat to its SQLite index, eliminating the throwaway-new-chat plus `/resume` workaround.
- Restore terminal sessions in the directory most recently reached with `cd`, and isolate Up/Down command history per Puddle session across shell and daemon restarts.
- Rename files inline from their editor-tab context menu instead of revealing a rename field in the Files sidebar, while keeping open views and unsaved buffers attached to the new path.
- Retire no-op editor drafts whose text already matches the file instead of repeatedly warning after an mtime-only rewrite.
- Keep remote Codex sessions rooted in their Puddle worktree so the footer and tools retain the correct directory and Git branch, while preserving safe resume for sessions created during the regression.
