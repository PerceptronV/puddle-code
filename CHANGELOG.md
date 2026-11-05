<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Cockpit

- Preserve current tabs when archive requests overlap so a late response cannot restore a previously closed session tab.
- Highlight draggable dividers between workspace islands with a bold rule on hover, keyboard focus, and while resizing.
- Float session sidebar controls above scrolling content, give the collapse control a matching square island, and preserve initial clearance above project titles.
- Fetch a fresh session list for notifications from uncached sessions so an incomplete cache cannot silently drop alerts from other projects.
- Restore live remote-session alerts while push registration is unconfirmed after a disconnect or failed reconnection.
- Recognise terminal paths containing spaces and multiline paths split before or after `/`, preserving full clickable ranges and resolve-validated fallbacks.
