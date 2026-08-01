<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Changed

- `puddle upgrade` with no subject now upgrades the CLI — the case you reach for when `puddle` itself is out of date. The `cli` subject it replaces is gone rather than kept as a quiet alias; typing it prints the new spelling. `puddle upgrade daemon [user@host]` and `puddle upgrade desktop` are unchanged.
- **Protocol 11.0 — every daemon upgrades on the next connection.** A deliberate major bump with no further schema change: 0.0.17 moved behaviour the UI silently depends on into the daemon (the new agent adapters, the hand-off endpoint, `agent_not_installed` refusals and the agent-availability fields, and the failure notices that surface agent and terminal errors). A 10.x daemon serves none of it and fails quietly rather than visibly, so no daemon may stay on 10.x.
- Tab chips shrink back to their title: the minimum width added in 0.0.17 is now just wide enough for the preview and close icons, rather than wide enough to keep a short filename legible beneath them. Chips still never resize on hover.

### Fixed

- Unpinning the sidebar while browsing above the worktree now returns the file tree to the active session's worktree. Entering a parent directory pins the sidebar, but releasing that pin left the tree stranded in the browse — it was keyed to the bound session, and unpinning does not change which session is bound, only how it is resolved.
