<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [0.0.29] — 2026-08-04

### Changed

- Claude Code account login now runs the agent's full TUI instead of `claude auth login`, so its own "Select login method" screen offers the choice between a Claude subscription and Console (API usage billing) — `auth login` has no picker and always took the subscription flow (verified 2.1.223). The login dialogue shows an adapter-provided hint (new optional `hint` on the login response, protocol 13.1) telling the user to `/exit` once signed in; a clean exit now VERIFIES login via the adapter's own `auth status` instead of assuming it, since quitting the TUI without signing in also exits cleanly.
- The desktop update reminder is a dismissable toast instead of a permanent bottom-right bar: it pops when a release is staged, offers "Restart to update", and dismissing it parks the offer until the next staged version or app launch.
- The desktop update cache self-cleans: staging a release prunes every other downloaded version under `~/.puddle/cache/desktop/`, and app boot sweeps leftovers (a stage always re-downloads fresh). Several releases behind, only the latest is downloaded and applied (`releases/latest`), never the intermediates.
- Monospace is now reserved for content that is genuinely code-shaped (terminal, editor, commit hashes, git status letters, matched search content, env var names, keyboard shortcuts, `${…}` templates). Everything else — file-tree and search paths, the top-bar host and profile names, tab labels and tab tooltips, session branch/agent lines in the right sidebar, account names, worktree/branch names in Changes and Worktrees, settings text inputs, dialogue references to names and paths — uses the sans face.

### Fixed

- Clicking an OSC 8 hyperlink in a terminal (how Claude Code prints URLs, e.g. the login OAuth link) no longer falls through to xterm's built-in handler — a native "this link could potentially be dangerous" confirm() that then opened a blank window the desktop shell refused, so accepting it opened nothing. OSC 8 links now open through the same path as plain-text links: no dialogue, real URL, SSH-mode localhost rewriting included.
