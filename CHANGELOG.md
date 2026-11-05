<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Cockpit

- Refine header typography, spacing and project colours while retaining profile colours; align Mac traffic lights and separate them from the hostname.
- Float tab and session actions above titles, use compact islands for lone close buttons, and keep linked/locked file indicators in the action tray.
- Move matching sidebar controls, project labels, session glyphs and selection markers between rail and expanded positions while resizing the live editor without cross-fading it.
- Add a saved Reduced animation and motion option below Density, included in settings sync, that disables interface animations and cursor blinking.
- Slide tray hover surfaces behind icons and persistent selections; retain selection positions across view changes and support dragging between magnetic slots.
- Fade dialogs and popovers in with a gentle scale change and animate toggle thumbs when motion is enabled.
- Split Settings into navigation and content islands, with a persistent vertical selection tray, spacious rows, and its title and close control inside the navigation island.
- Highlight facing island borders when resizing, tapering around rounded corners while leaving the gap empty.
- Open session search from the collapsed rail, remove its redundant clear cross, and use matching plain sidebar collapse controls.
- Search displayed sidebar sessions by title, branch, agent, account, and project from an expanding search tray, respecting project scope and archived visibility.
- Preserve current tabs when archive requests overlap so a late response cannot restore a previously closed session tab.
- Highlight draggable dividers between workspace islands with a bold rule on hover, keyboard focus, and while resizing.
- Float session sidebar controls above scrolling content, give the collapse control a matching square island, and preserve initial clearance above project titles.
- Fetch a fresh session list for notifications from uncached sessions so an incomplete cache cannot silently drop alerts from other projects.
- Restore live remote-session alerts while push registration is unconfirmed after a disconnect or failed reconnection.
- Recognise terminal paths containing spaces and multiline paths split before or after `/`, preserving full clickable ranges and resolve-validated fallbacks.

### Daemon

- Publish private supervision markers during installation instead of retaining legacy writable permissions that block daemon updates.

### Runtime

- Remove undispatched launch files after rejected placement preparation so failed launches do not leave unknown runtime records that block daemon updates.
