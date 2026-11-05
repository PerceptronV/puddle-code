<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Cockpit

- Unify menu, field, mobile tray and native prompt styling with the shared island palette, geometry and optional motion; retain readable gold selection text and keyboard access to floating tab actions.
- Keep the hostname in the standard primary text colour independently of project colour, and group collapsed sessions into one scrollable island with project dividers above the bottom archive button.
- Preserve tray selection continuity across remounts and use rounded facing-edge feedback for internal resize handles, including keyboard resizing.
- Align folder and file staging actions in a fixed column in Changes.
- Show lone tabs as full panes with a top-edge path tooltip; opening or dropping a second file restores the tab strip. Keep floating action tooltips above the pane and inside the window.
- Slide session hover feedback between rows in both expanded and collapsed sidebars, respecting reduced motion.
