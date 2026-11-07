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

- Compile or run the focused source file with Command+Enter through the existing save-before-run flow.

- Add per-file editor settings for tab size, word wrap and searchable syntax language, with inherited defaults and window-local overrides.

#### Fixed

- Halve the PDF zoom overlay inset, keeping equal spacing from the top and right edges.

- Suspend eager compilation while source-input save conflicts remain unresolved, including across reconnects, and resume after a checked editor resolution.

- Keep eager compilation registered across pane moves and background tabs, and restore observation and PDF refresh after idle expiry or daemon replacement.

- Keep single-tab action trays above file details and reachable from the top-right corner, including narrow LaTeX panes.

- Keep the newest covered Ripple output visible at a high boundary by omitting older complete blocks first, preserving pinned prompts, fixed typography and original terminal click anchors. Restore omitted content when the reading area expands.
- Remove the Ripple divider line and place a vertical handle at the far-right edge, retaining the larger mobile touch target.

- Keep Ripple scrolling in the underlying CLI, reserve two terminal rows for breathing room and keep its reading view top-aligned with fixed typography. Restore the full grid for CLI-only viewing; preserve anchored clicks and normal scrollback, and clip excess output without a second vertical scroller or changing styles.
- Use primary text for non-ignored explorer names, including dotfiles, while retaining muted ignored files and Git status colours.

### Daemon

#### Fixed

- Preserve file timestamps and skip eager rebuilds for unchanged saves; hold queued builds after stale saves until their input conflicts resolve.

- Trigger eager compilation directly after successful saves, retain source watches across incomplete dependency reports, verify missed external source changes each second, and preserve LaTeX dependencies through symlinked roots.
