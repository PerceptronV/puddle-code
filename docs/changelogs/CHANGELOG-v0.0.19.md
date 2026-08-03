<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [0.0.19] — 2026-08-02

### Changed

- Adding an account is one button and one dialogue. The inline label field, **Add account** and **Import existing…** — three controls per agent for what is really one action — collapse into a single **Add account** that opens the dialogue import already used. The config directory there is optional: name the account and puddle creates it and takes you to the agent's login, or point at an existing config dir to copy it in.

### Added

- **Open Terminal in Directory** on the file tree's folder context menu: starts a terminal session whose shell begins in that folder rather than the worktree root. The directory is remembered, so resuming the session after a daemon restart returns to it, and extra shell tabs open there too. Protocol 11.1 (additive `cwd` on the session shape and on terminal creation).
- Session tabs now carry the agent's brand mark beside the status dot, matching the sidebar, so you can tell a Claude Code tab from a Codex one at a glance. Terminal tabs are unchanged — the status dot already says what they are.

### Fixed

- Codex sessions show their real name, and a rename appears within a few seconds. Codex keeps session names in its own `state_<n>.sqlite` rather than in the rollout file, which puddle never read — so every codex session fell back to the terminal title, which codex sets to the working directory's basename. Every session in a repo therefore showed the same static name and a rename never surfaced.
- Browsing to the top of the file tree no longer reports "path escapes the worktree" for every entry. Walking up to the filesystem root left the containment check comparing paths against `//`, so nothing under `/` could be listed, opened, or saved — expanding `Users` failed even though the browse root explicitly allowed it. Reading and editing files anywhere above the worktree now works, and genuine escapes are still refused.
