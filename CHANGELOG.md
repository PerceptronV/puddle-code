<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Changed

- Archiving is one gesture for any session: the ⋯/right-click menu offers
  Archive on live agents and terminals too — the daemon kills the session as
  part of archiving (still a reversible hide; unarchive brings it back
  resumable), so there is no kill-first dance and no confirmation dialog.
  Protocol 9.3.
