<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- Add Monaco-style in-view find to rendered file previews and terminal sessions with case, whole-word, and regular-expression matching.
- Report every installed component's app and speaking-protocol version from `puddle --version`, and show the desktop protocol in macOS's correctly named About Puddle panel.

### Changed

- Restore the desktop's open cockpit windows after ordinary quits and restarts, retaining their monitor-relative bounds on macOS and X11 and their virtual desktop on X11 when available.
- Reveal and expand worktree directories opened through the command palette in Files without pinning the sidebar.
- Present worktree choices with the same session metadata hierarchy as tab tooltips, including terminal type labels.
- Align repository headings, branch metadata, and changed-file trees into a clearer source-control hierarchy.

### Fixed

- Synchronise scrolling from a focused locked preview to matching source tabs and other locked previews.
- Bottom-align the macOS desktop window so its lower border launches flush with the work-area edge.
- Build Linux release tarballs with Python 3.11 on the glibc 2.28 image so node-gyp can compile native dependencies.
