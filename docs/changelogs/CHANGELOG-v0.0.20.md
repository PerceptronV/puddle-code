<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [0.0.20] — 2026-08-03

### Changed

- Place Settings → Sync export above import, keeping the one-click export-and-copy flow ahead of the paste target it produces.
- Session rows and tabs show one glyph, not two: the agent's brand mark (or a terminal glyph) drawn in the status colour, replacing the separate coloured dot beside it. The collapsed session rail keeps the dot — there is no mark beside it to deduplicate. The sidebar's account line drops its agent mark too, now that the row already leads with one.

### Fixed

- Show Codex's observed idle composer and Claude's first completed prompt as waiting-for-input green instead of leaving their status running amber.

### Removed

- Status animations, and the **Reduced motion** setting with them. The running ripple and the waiting pulse are gone: the indicator's colour already carried the state and the motion only repeated it, at the cost of compositor frames after every status change on every visible session. With nothing left animating there is nothing for reduced motion to reduce, so the Appearance toggle has gone too — an existing value in local storage is simply ignored, and an imported settings payload carrying it is skipped.
