<!--
Archived release changelog. Governance lives in CLAUDE.md §"Changelog discipline".
-->

# Changelog

## [0.3.7] — 2026-10-23

### Added

- Add notebook Python environment selection for project virtual environments, Conda/Mamba installations and user-entered paths, with explicit installation of missing `ipykernel`/`nbconvert` packages (protocol 25.1).

### Fixed

- Initialise newly created empty `.ipynb` files with a valid version 4 notebook, including blank drafts saved as notebooks.
