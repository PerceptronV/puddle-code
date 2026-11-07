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

- Keep Ripple scrolling in the underlying CLI, reserve two terminal rows for breathing room and keep its reading view top-aligned with fixed typography. Restore the full grid for CLI-only viewing; preserve anchored clicks and normal scrollback, and clip excess output without a second vertical scroller or changing styles.
- Stop Ripple’s divider before its handle, align its outer insets and move the handle closer to the right edge using its original theme colours.
- Use primary text for non-ignored explorer names, including dotfiles, while retaining muted ignored files and Git status colours.
