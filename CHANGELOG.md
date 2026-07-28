<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- Host display name: `config.json` gains `displayName` (Settings → Host), shown
  in place of the OS hostname across the UI — notably the top-left home button.
  `GET /api/host` reports it; ssh-forward commands keep the real hostname.
  Protocol 9.2.
- Folder drag-and-drop upload: dropping a directory onto the file explorer now
  uploads its whole tree (walked in the browser; each file travels under its
  relative path and the daemon creates the intermediate directories — empty
  directories are skipped). On a pre-9.2 daemon folders are still rejected with
  the zip-first toast, feature-detected via `GET /api/version`. Protocol 9.2.

### Changed

- Markdown/HTML preview (SPEC §8): both previews now resolve worktree asset
  references — relative to the document or `/`-absolute from the worktree
  root. The sandboxed HTML iframe inlines its assets (images, scripts,
  stylesheets, icons, media) as data URIs through the authed API; markdown
  images keep the object-URL path. Ctrl/⌘-click on a worktree link in a
  markdown preview opens that file as an editor tab, with markdown/HTML
  targets landing straight in their rendered view.

### Fixed

- Large uploads: folder drops are split into ~64 MiB requests client-side, the
  daemon's per-request cap rose 100 → 512 MiB (it now only binds on a single
  huge file), and the over-cap error reads in MB instead of raw bytes.
- New agent/terminal dialog: the "Directory to join" select no longer overflows
  the dialog — the collapsed trigger shows just the directory name, and the open
  list shows the `~`-compressed path (full path on hover) with the menu capped
  to the viewport.
