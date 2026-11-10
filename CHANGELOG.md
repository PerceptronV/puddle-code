<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Frontend

#### Fixed

- Raise the connected host window after the native host picker or SSH prompt has closed, and keep the prompt open when no destination window was created.

### Daemon

#### Fixed

- Allow daemon startup after a reboot renumbers the memory ledger's filesystem device, preserving sealed identity, capacity and outstanding runtime grants.
