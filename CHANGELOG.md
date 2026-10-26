<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- Render Jupyter widgets with the official manager, including live controls, linked models, Markdown/maths, callback output, binary uploads/images, compatible custom extensions and saved notebook state.
- Retain Jupyter widget state and binary buffers across cell runs, forward live widget comms and Output callbacks, and reject actions from retired kernels (protocol 25.4).

### Fixed

- Place notebook input prompts inside the executing cell's output with Enter submission, Ctrl+C interruption and fresh input state for each prompt.
- Keep Output widget capture and display updates working between cell runs and preserve widget metadata in executed copies.
- Restore widget views after event-history gaps without repeating callbacks, and retain trait changes when the kernel disables echo updates.

