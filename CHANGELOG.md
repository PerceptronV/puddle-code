<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Frontend

#### Fixed

- Restore bounded host-specific project lists while refreshing, and show remote projects before repository, session, ordering and release-note reads finish.
- Pace congested browser WebSocket bridges and adapt routine polling to observed host response times.
- Apply mobile session status and title events directly to cached lists instead of downloading the session catalogue on every event.
- Preserve the original LaTeX delimiters when showing inline maths source in terminal overlays and Ripple.
- Keep custom cursors moving continuously across interactive terminal overlays that isolate pointer events.
- Centre the collapsed Archived sessions row vertically within its island.
- Animate the Archived island opening and closing, and open its contents directly from the collapsed sidebar's archive button.

### Daemon

#### Changed

- Compress terminal WebSocket messages and large JSON API responses before they cross SSH tunnels, retaining uncompressed compatibility and exact terminal bytes.
