<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

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

- Desktop (macOS): the merged title bar is a little slimmer (44 → 40px, traffic
  lights re-centred), so the workspace chrome sits closer to the lights.

- Light theme: exited/idle status dots are neutral grey instead of warm bark brown (matching the 2026-07-16 muted-text re-grey; dark theme was already grey).
- Desktop (macOS): more breathing room between the traffic lights and the host name in the merged title bar.
