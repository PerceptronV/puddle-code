<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [0.0.35] — 2026-08-09

### Changed

- Auto-resume ("Resume sessions" in Settings → Host) is now ON by default: a daemon restart brings interrupted sessions straight back. Config version 3 migrates an existing `autoResume: false` — the old default that `loadConfig` wrote to every config.json — to true exactly once; a false set after the migration is respected.

### Fixed

- The accounts UI's logged-in badge now updates the moment a login verifies. The daemon records the flag only after the agent's own auth check answers — after the login dialog has closed — so the badge sat stale until an unrelated refetch; it now broadcasts an `account` WS message on every change and the UI patches its cached lists live. Protocol **15.1** (additive).

### Added

- Markdown/HTML tabs gain a third view mode, **linked** (chain icon): the tab chip's toggle now cycles source → preview → linked, the icon naming the current mode. A linked tab is a follow-along rendered preview — it retargets to the most recently active renderable tab (every linked pane moving together), scoped per project under project-based layout and profile-wide otherwise, and keeps rendering its last target until the next one. Protocol **15.0** (major: a 14.x daemon's strict `view` enum would reject any snapshot carrying a linked tab, so it must auto-upgrade rather than fail every workspace save).
- The desktop app's "Restart to update" reopens the windows it closed: the shell records every open window's target (local and SSH — targets only, never credentials) as the swap begins, and the relaunch brings each back, falling back to the host picker when none can be reopened. One-shot with a 15-minute TTL, so a failed swap's leftover cannot resurrect windows on a later launch.
