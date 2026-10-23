<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- Add editable `.ipynb` notebook views with saved rich output, a JSON source toggle, and explicit whole-notebook execution through host-installed Jupyter.
- Run Python, JavaScript, TypeScript, C, C++, Rust, Go, Ruby, Perl, R and shell files with detected host tools, per-file command overrides, bounded output and managed result tabs; keep code execution manual.

### Changed

- Advance the daemon/cockpit protocol to 24.3 for an optional compilation-provider action label; retain LaTeX eager controls only for providers that advertise eager support.
