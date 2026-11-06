<!--
Archived release changelog. Governance lives in CLAUDE.md §"Changelog discipline".
-->

# Changelog

## [0.4.13] — 2026-11-06

Include the cockpit fixes from v0.4.12, whose release workflow failed before publication.

### Cockpit

#### Fixed

- Use the lighter file-hover fill for accented form fields and inactive switches, preserving default controls and stronger island borders.

- Preserve the original default theme and soften preset/custom accent backgrounds to one-third strength. Keep reading areas and active tabs untinted, match pane frames to sidebars, and strengthen accent borders beyond all background layers.

- Keep Ripple active for Codex and other alternate-screen agents, rendering current screen contents with copyable text, Mermaid and LaTeX while preserving native CLI controls.

- Clicking, tapping or scrolling closed session transcripts no longer raises connection errors from restored terminal mouse reporting.

### Daemon

#### Fixed

- Restore selective component releases by validating packaged continuity against the manifest’s published daemon and runtime versions, including checksum-verified retained runtime downloads.
