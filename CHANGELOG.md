<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- Add notebook search and replacement, heading sections, cell copy/paste, image downloads, SVG/JSON output, Markdown attachments and shared asset/Mermaid rendering.
- Add kernel-backed notebook completions and hover documentation without starting kernels on typing (protocol 25.3).

- Add inline notebook cell and range execution with live output, input prompts, cancellation and persistent kernel state (protocol 25.2).

- Add Monaco notebook cells, Markdown editing shortcuts, searchable cell languages, a left execution gutter, insertion, duplication, splitting, merging and structural undo.

### Changed

- Route notebook header and open-tab runs through interactive execution; retain Run to Executed Copy in the notebook menu.
- Preserve notebook outputs and execution counts while editing source.
- Reduce the minimum file and session tab width to 80% of its previous size.
