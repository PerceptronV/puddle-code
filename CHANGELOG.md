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
- The desktop app gets its own default hotkey set where native gestures are more intuitive: ⌘W closes the current tab (the shell's Close Window moves to ⌘⇧W), ⌘B toggles the left sidebar, ⌘T opens a new agent. Web defaults are unchanged, and per-profile custom bindings still apply in both shells.
- Projects carry a customisable ≤5-character abbreviation (protocol 12.1) — the collapsed sidebar rail's label. Set it at creation (prefilled from the name), edit it with the name in the homescreen card's Edit dialogue, or single-click the active project's label in the sidebar to edit in place: the abbreviation on the collapsed rail, the full name on the expanded header. Clicking any other project still navigates.
- Single-clicking the already-selected file or folder in the file tree starts an inline rename (Finder-style, after a beat so double-click still opens); F2 keeps working.

### Changed

- Markdown and HTML previews follow the editor font size setting (HTML as a zero-specificity default the document's own styles override).
- A dirty editor tab's dot now sits after the filename — the chip widens for it up to its cap, past which the name truncates — instead of overlaying the title; it hides on hover where the close × appears.
- New sessions default to working directly on the base branch in its shared directory, for agents and terminals alike; separate branch/directory remain one toggle away and per-profile seeds still override.
- "Sync locally" is enabled by default (every group) for profiles with no stored entry; the toggle still turns it off.
- The Density setting does something: compact (the default) tightens vertical spacing in both sidebars — session rows, rail dots, file-tree rows — and the collapsed rail's session glyphs grew to fill their containers; comfortable keeps the previous roomier spacing.
- Numeric settings inputs commit on blur or Enter instead of every keystroke, so a font size can be cleared and retyped without applying mid-edit; empty or invalid input reverts.

- The "All projects in the sidebar" setting became "Project-based layout" (its inverse; a stored choice migrates). The sidebar's Archived disclosure now follows the same scoping: every project's archived sessions in the default profile-based layout, only the current project's under project-based layout.
- Protocol major bumped to 12.0 (no schema change beyond 11.2's additive keys, on purpose): every connected daemon auto-upgrades at the next `puddle launch` handshake, so all deployments parse the project-based-layout snapshot keys instead of merely round-tripping them, and none linger on early 11.x.

### Removed

- The "browser-reserved" warnings in Settings → Hotkeys (the ⌘W/⌘T/… flagging and the intro's caveat): any combo is bindable without commentary; the conflict warning between two app shortcuts remains.

### Fixed

- Optional form fields no longer sit empty and get silently reinterpreted on submit: the profile-creation branch prefix, the new-session base branch, and the tab-title template are prefilled with the default they would have become (clearing the profile branch prefix now honestly means no prefix). Placeholders that lied were corrected — the settings branch prefix says "no prefix", the host display name shows the real hostname fallback, the editor SSH-host field shows the tunnelled host already in effect — and clearing a numeric host setting no longer PATCHes a rejected 0. The settings "Repositories" tab is now "Projects" (old #settings/repositories links still resolve).
