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

- Fix Ripple URLs polluted by style markers; reuse native wrapped URL/path detection, resolution and opening behavior, including Command/Ctrl-click file links. Relay Codex disclosure clicks to their current terminal cells and group indented multiline prompts, lists and paragraphs into one user bubble.
