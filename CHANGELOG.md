<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Fixed

- Let `puddle upgrade desktop` install the latest macOS app when no existing Puddle bundle is present, choosing writable `/Applications` or falling back to `~/Applications` and no longer requiring an old bundle to swap aside.
- Add an independent Monaco editor font-size control in Appearance; changing it does not change terminal text.
- Tighten adjacent captured-environment and ports rows beneath a terminal pane.
