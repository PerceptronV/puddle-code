<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Fixed

- Codex login no longer shows an empty panel on remote hosts: `codex login` opens a browser and a localhost OAuth callback on the DAEMON host while rendering nothing in the PTY. The login dialogue now runs the bare `codex` TUI — its own first-run sign-in screen (ChatGPT or API key) renders in the terminal, matching the Claude Code login flow — with the dialogue hint explaining how to exit once signed in. Gemini CLI's (already TUI-based) login gains the same hint; OpenCode keeps `auth login`, which renders in the PTY and exits cleanly by itself.
- Switching (or creating) a profile now lands on that profile's dashboard. The picker replaced the router without touching the address, so the previous profile's project URL was still current when the router came back — and a project route binds the workspace to the project's OWNING profile, so a brand-new profile appeared to have inherited the old profile's projects, sessions, and layout wholesale.
