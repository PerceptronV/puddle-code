<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- Three new coding agents: **Codex**, **OpenCode** and **Gemini CLI**, each an adapter under `packages/daemon/src/agents/` with its flags pinned against a verified version (codex-cli 0.146.0, opencode 1.18.10, @google/gemini-cli 0.53.1). Accounts, login, sessions, resume and skip-permissions work for all three; the sidebar gains their brand marks. Manual checks that need a logged-in account live in `docs/acceptance/phase-7-agents.md`.
- **Cross-agent hand-off**: the session menu gains "Hand off to agent…", which starts a new session on a different agent in the same worktree and branch, opening with a summary of the conversation so far plus the branch's commits and working-tree status. The original session keeps running and the two are linked. `POST /api/sessions/:id/handoff`, protocol 10.6 (additive).
- Agent-binary detection: `GET /api/agents` now reports each adapter's `binary` and whether it is `available` on the daemon's PATH, and Settings → Accounts and the profile panel disable the add-account and login controls for an agent whose CLI is missing, explaining which executable was not found and pointing at the agent search path. Protocol 10.5 (additive).

### Fixed

- **Agent and terminal failures are no longer silent.** An agent or shell that exits non-zero without being asked to now raises a toast naming what happened and quoting the process's own last output — a rejected CLI flag, a failed credential, a crash. It reaches you whichever tab you are on, rather than only a client attached to that terminal, and stays quiet for stops you asked for (kill, archive, closing a shell). Protocol 10.7 (additive `notice` message).
- WebSocket errors were written to the browser console and nowhere else; they are now toasts.
- Every mutation now has a global error handler, so an action can never fail silently because its call site forgot one. Duplicate reports of the same failure collapse into a single toast.
- Logging in to an account whose agent CLI is not installed no longer opens a terminal dialog that flashes open on an empty screen and vanishes. Login, session create/resume and migration now fail up front with `424 agent_not_installed`, naming the missing executable. node-pty does not report a missing executable on macOS, so nothing had ever caught this.
- A missing agent CLI no longer clears an account's stored logged-in flag. `checkLoggedIn` asks the agent's own CLI, so an uninstalled agent answered "logged out" and the daemon believed it — downgrading authenticated accounts on every boot and on every rejected session create.
- The login dialog no longer closes silently when the login process exits non-zero; it stays open and reports the exit code so the agent's own output remains readable.
