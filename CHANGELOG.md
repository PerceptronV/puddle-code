<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- Sidebar project names (expanded header and collapsed rail label) right-click into a menu that starts a new agent or terminal in that project, and drag to reorder projects — persisting the same `projectOrder` the homescreen cards drag; while a name drags, the session lists collapse so only the names reposition.
- The collapsed rail's project label shows the full project name in a tooltip.
- Project-based layout (Settings → Appearance, default off; protocol 11.2): the centre editor persists one layout per profile **and project** — switching projects swaps in that project's own tiling tree and restores its active session — while the sidebar keeps every project name but lists only the current project's sessions. Toggling converts the snapshot once: on splits the shared tree into per-project slices (each keeping its structure with only that project's tabs), off unions the slices back side by side with tabs deduplicated.

### Changed

- The "All projects in the sidebar" setting became "Project-based layout" (its inverse; a stored choice migrates). The sidebar's Archived disclosure now follows the same scoping: every project's archived sessions in the default profile-based layout, only the current project's under project-based layout.
- Protocol major bumped to 12.0 (no schema change beyond 11.2's additive keys, on purpose): every connected daemon auto-upgrades at the next `puddle launch` handshake, so all deployments parse the project-based-layout snapshot keys instead of merely round-tripping them, and none linger on early 11.x.

### Removed

- The "browser-reserved" warnings in Settings → Hotkeys (the ⌘W/⌘T/… flagging and the intro's caveat): any combo is bindable without commentary; the conflict warning between two app shortcuts remains.
