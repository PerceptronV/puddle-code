<!--
Archived release changelog. Governance lives in CLAUDE.md §"Changelog discipline".
-->

# Changelog

## [0.5.7] — 2026-11-14

### Frontend

#### Fixed

- Cancel obsolete explorer, editor, search, Git and catalogue reads when their last consumer leaves, freeing connection capacity for the next view.
- Load dashboard paths, ordering and session counts with one compact catalogue request on supporting hosts, avoiding full session transfers and per-project count requests.
- Restore bounded host-specific project lists while refreshing, and show remote projects before repository, session, ordering and release-note reads finish.
- Pace congested browser WebSocket bridges and adapt routine polling to observed host response times.
- Apply mobile session status and title events directly to cached lists instead of downloading the session catalogue on every event.
- Preserve the original LaTeX delimiters when showing inline maths source in terminal overlays and Ripple.
- Keep custom cursors moving continuously across interactive terminal overlays that isolate pointer events.
- Centre the collapsed Archived sessions row vertically within its island.
- Animate the Archived island opening and closing, and open its contents directly from the collapsed sidebar's archive button.

### Daemon

#### Changed

- Revalidate unchanged local/SSH JSON responses with private HTTP validators, avoiding repeat bodies while preserving current authority and content checks.
- Add the profile-scoped compact project catalogue (application protocol 28.35), streaming status columns without full session allocation or filesystem probes.
- Compress terminal WebSocket messages and large JSON API responses before they cross SSH tunnels, retaining uncompressed compatibility and exact terminal bytes.
