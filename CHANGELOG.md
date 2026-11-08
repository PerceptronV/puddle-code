<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Cockpit

#### Changed

- Separate native window lifetime from host connections and retain revisioned desktop working sets and acknowledged transfer records (application protocol 26.7; detached-window controls are in progress).
- Flush desktop working sets and dirty drafts before native close or Command-Q, and cancel closure when a renderer cannot confirm its checkpoint.
