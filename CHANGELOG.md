<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- Reveal the associated rooted source-editor line when a linked or locked Markdown/HTML preview is Ctrl/Command-clicked.
- Compile LaTeX sources on demand or eagerly on daemon-observed disk changes when the connected host has a supported local toolchain, keeping every generated file under Puddle’s data directory and opening the PDF as a persistent, globally deduplicated file tab.
- Navigate from Command/Ctrl-clicked generated PDF positions to the corresponding TeX source through a lazy PDF.js viewer and inverse SyncTeX.
- Expose a provider-neutral compilation protocol and daemon scheduler so future compiled file types can reuse capability discovery, modes, watchers, status, and artefact handling.
- Show failed compiler output in expandable notifications and mark normalised source diagnostics in Monaco.

### Changed

- Align locked Markdown and HTML previews by parser-derived source lines across wrapping, media, and reflow, with proportional progress as a safe fallback.
- Save the selected source and mounted provider-input buffers before compilation, and refresh eager PDF output without stealing editor focus.

### Fixed

- Keep every cursor package in caret form across the full Monaco surface and preserve custom cursors over command-palette gutters.
