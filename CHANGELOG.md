<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- `puddle install <daemon|desktop>[@version] [user@host]` — ensure a component is present: a no-op (that says so) when it already is and no version is named; an exact version otherwise, downgrades included. Pinning the daemon to a version other than the CLI's own prints a warning that the next `puddle launch` would force-upgrade it across a protocol major (pin the CLI too, or launch `--no-upgrade`).
- `puddle upgrade` grows components and versions: `[cli|daemon|desktop][@version] [user@host]` moves one component to the newest release (resolved from GitHub, falling back to the CLI's version train offline) or the named one, installing it when missing; **bare `puddle upgrade` now upgrades everything installed on the target** (previously it meant the CLI alone), the CLI strictly last since npm replaces the running code; `upgrade cli` is a valid spelling again.
- `puddle remove <cli|daemon|desktop> [user@host]` — confirmed removal, defaulting to no (`--yes` for scripts). Removing the daemon lists its version, the running sessions it interrupts, and its profiles first; it stops and unregisters the supervisor (systemd/launchd/nohup) and keeps `~/.puddle`'s data — profiles, session history, worktrees, credentials — unless separately confirmed (`--purge`), and before purging it sweeps worktrees for uncommitted or unpushed work and asks again when it finds any. cli removal requires a real npm global install; desktop removal deletes the closed macOS bundle and its staged-update cache.
