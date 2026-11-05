<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Cockpit

- Keep five-character project abbreviations readable inside the mobile session rail.
- Dismiss terminal selection actions after copying or clearing a touch selection, without reopening an empty toolbar.
- Wait for active dialogs to close before showing automatic release notes, preserving pairing and settings interactions.

### Daemon

- Generate valid systemd working directories for independent runtimes and update workers, so Linux launches no longer fail before readiness.

### Runtime

- Keep Codex 0.164+ fallback launches in the foreground so restarting a terminal does not leave its conversation owned by Codex’s shared background daemon.

