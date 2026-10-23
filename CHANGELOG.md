<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- Add notebook Python environment selection for project virtual environments, Conda/Mamba installations and user-entered paths, with explicit installation of missing `ipykernel`/`nbconvert` packages (protocol 25.1).

### Fixed

- Initialise newly created empty `.ipynb` files with a valid version 4 notebook, including blank drafts saved as notebooks.
