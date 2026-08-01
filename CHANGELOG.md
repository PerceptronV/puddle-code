<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- Agent-binary detection: `GET /api/agents` now reports each adapter's `binary` and whether it is `available` on the daemon's PATH, and Settings → Accounts and the profile panel disable the add-account and login controls for an agent whose CLI is missing, explaining which executable was not found and pointing at the agent search path. Protocol 10.5 (additive).

### Fixed

- Logging in to an account whose agent CLI is not installed no longer opens a terminal dialog that flashes open on an empty screen and vanishes. Login, session create/resume and migration now fail up front with `424 agent_not_installed`, naming the missing executable. node-pty does not report a missing executable on macOS, so nothing had ever caught this.
- A missing agent CLI no longer clears an account's stored logged-in flag. `checkLoggedIn` asks the agent's own CLI, so an uninstalled agent answered "logged out" and the daemon believed it — downgrading authenticated accounts on every boot and on every rejected session create.
- The login dialog no longer closes silently when the login process exits non-zero; it stays open and reports the exit code so the agent's own output remains readable.
