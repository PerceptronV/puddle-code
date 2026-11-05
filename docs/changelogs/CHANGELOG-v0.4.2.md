<!--
Archived release changelog. Governance lives in CLAUDE.md §"Changelog discipline".
-->

# Changelog

## [0.4.2] — 2026-11-04

### Cockpit

- Float workspace panes and sidebars as rounded, outlined islands with shared spacing, while keeping editor surfaces inset and resize handles unobtrusive.
- Unify navigator and action trays, using gold for selected modes, clearer hover feedback, and matching collapsed controls, project groups and archive targets.
- Present the header as one compact island with inset vertical separators and a screen-centred command hint; clicking its central area opens the palette.
- Separate History and expanded Archive into independent, resizable sidebar islands; separate repository and project groups with horizontal dividers.
- Apply shared island outlines and rounding to dashboard tiles, the home terminal, dialogs and popouts while preserving overlay shadows and the Settings divider.
- Restyle the file tree with roomier inset rows and filled theme-coloured folders that follow Git status, including descendant changes.
- Bundle MIT-licensed Material file-type icons and share them across the explorer, editor tabs, Search and Changes.
- Show the navigator's folder basename in bold at the file-tree font size, scroll from the left, and reveal the full path in a right-aligned hover tooltip.
- Float active tabs and support dragging whole panes from blank tab-strip space to swap or reposition them without losing their tabs.
- Balance editor gutter spacing and grow the line-number width with the file length.
- Group notebook actions and PDF zoom controls into shared trays, and give notebook source and output areas separate borderless, deeper-background subislands.
- Fix inline diff close clicks intercepted by Monaco's text layer and detach diff controllers before shared models are disposed during responsive layout changes.
- Add a daemon-free UI preview with editable sample files, notebook/PDF fixtures and browser checks for navigation, pane dragging and inline diff controls.
