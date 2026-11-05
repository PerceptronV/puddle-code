<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Cockpit

- Fetch a fresh session list for notifications from uncached sessions so an incomplete cache cannot silently drop alerts from other projects.
- Recognise terminal paths containing spaces and multiline paths split before or after `/`, preserving full clickable ranges and resolve-validated fallbacks.
