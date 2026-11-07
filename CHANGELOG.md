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

- Map Ripple text clicks to original terminal cells instead of recognising Codex disclosure labels; preserve native pinned-prompt navigation without absorbing following diffs into the prompt bubble.
- Keep Codex’s Working indicator native, leave breathing room above CLI controls, account for partial terminal rows, preserve numbered diff line breaks and hide Ripple’s overflow scrollbars while retaining scrolling.
