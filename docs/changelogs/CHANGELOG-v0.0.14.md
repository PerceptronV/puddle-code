<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [0.0.14] — 2026-07-28

### Added

- Desktop self-update, no code signing required: the app polls GitHub
  releases, downloads and SHA256SUMS-verifies the new build into
  `~/.puddle/cache/desktop/`, and offers a "Restart to update" banner; a
  detached helper swaps the install after quit and relaunches (SPEC §10 —
  the CLI-style alternative to Squirrel, which refuses unsigned bundles).
  The helper strips `com.apple.quarantine` from the swapped bundle as
  defence in depth, and a Linux AppImage updates in place at `$APPIMAGE`,
  wherever the user keeps it.
- `puddle upgrade` now names its subject: `puddle upgrade daemon [user@host]`
  (the previous behaviour), `puddle upgrade cli` (npm under the hood), and
  `puddle upgrade desktop` (the app's update pipeline, run while the app is
  closed). `cli`/`desktop` refuse remote targets — only the daemon lives on
  remote hosts.

### Fixed

- Battery: the file explorer no longer pins a CPU core for as long as it is
  mounted. Its query-cache subscription reacted to *observer* events — which
  fire during React renders themselves — so every workspace window sat in a
  permanent render → cache-event → re-render loop (the "Puddle is using
  significant energy" report). The subscription now only reacts to query-state
  events (data landing, cache add/remove). Measured on an idle workspace
  (file tree + attached terminal): 83–112% CPU per window before, 0–1.2%
  after; whole app now idles at ~1–2% of one core total, below macOS's
  significant-energy threshold. Full write-up with methodology in
  `docs/reports/2026-07-28-explorer-render-loop.md`.

### Changed

- `puddle start` and `puddle connect` are unified into
  `puddle launch [local | user@host]` — no target means local, and every flag
  from both verbs (`--port`, `--prefer-port`, `--remote-port`, `--no-browser`,
  `--no-upgrade`, `--tarball`, `--foreground`) rides along. The old verbs
  error with the exact replacement.
- Desktop: new windows no longer default to local. Launching the app, ⌘N,
  Window → New Window, and the macOS dock icon's right-click New Window all
  open a host picker — "This machine" on top, then recent hosts, then
  "Other SSH host…" — and nothing connects until you pick.
- Desktop: recent hosts moved from the app's userData dir to
  `~/.puddle/recent-hosts.json` (migrated automatically), so they survive
  app updates and reinstalls.
- Desktop (macOS): the merged title bar is a little slimmer (44 → 40px, traffic
  lights re-centred), so the workspace chrome sits closer to the lights.

- Light theme: exited/idle status dots are neutral grey instead of warm bark brown (matching the 2026-07-16 muted-text re-grey; dark theme was already grey).
- Desktop (macOS): more breathing room between the traffic lights and the host name in the merged title bar.
