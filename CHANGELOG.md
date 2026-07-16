<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- `README.md` gained a **Development & teardown** section: running a local dev build (`--tarball`/`--foreground`) versus the published CLI, killing the cockpit vs. stopping the daemon service (launchd/systemd/nohup), and a full uninstall.

### Fixed

- A session's tab title now tracks a rename made **inside the agent** (e.g. claude-code's `/rename`) live, instead of only after the next status change. Such renames are handled client-side and change no puddle status, so the daemon never re-read the agent's name; it now also re-reads it (throttled) when the agent emits a terminal-title escape sequence (OSC 0/1/2), which claude-code does on rename. The transcript remains the source of truth and a user rename still wins (SPEC §4).
