<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Cockpit

#### Fixed

- Keep the newest covered Ripple output visible at a high boundary by omitting older complete blocks first, preserving pinned prompts, fixed typography and original terminal click anchors. Restore omitted content when the reading area expands.
- Remove the Ripple divider line and place a vertical handle at the far-right edge, retaining the larger mobile touch target.

- Keep Ripple scrolling in the underlying CLI, reserve two terminal rows for breathing room and keep its reading view top-aligned with fixed typography. Restore the full grid for CLI-only viewing; preserve anchored clicks and normal scrollback, and clip excess output without a second vertical scroller or changing styles.
- Use primary text for non-ignored explorer names, including dotfiles, while retaining muted ignored files and Git status colours.
