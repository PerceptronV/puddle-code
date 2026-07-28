<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- Notifications actually fire now: when an agent flips to waiting for input,
  puddle shows a desktop notification (while the window is unfocused; clicking
  it opens the session), plays the optional sound, and badges the tab title
  with the count of waiting agents — honouring the Notifications settings and
  per-project mutes. Enabling the desktop toggle asks for browser permission.

- A `running` agent that has recorded no transcript activity for over an hour
  is flagged `stale_running` (computed on read, protocol **10.1** — additive):
  the UI fades its status dot, drops the ripple, and hints "possibly stalled".
  Advisory only — the daemon never interrupts an agent over it.

- Desktop shell (`packages/desktop`): puddle now also builds as a standalone
  Electron app. The main process drives the exact same cockpit engine as the
  `puddle` CLI (`startLocal` from the new embedder surface
  `@puddle-code/cli/lib`) and opens a window on the embedded cockpit — one
  codebase, two downstream builds. External links and editor deep links open
  via the OS, the connection banner's refresh restarts the cockpit
  in-process, notification clicks raise the window, and quitting never
  touches the daemon or running agents. `pnpm --filter @puddle/desktop start`
  to run, `… dist` to package (dmg/zip/AppImage).

### Fixed

- Battery: the web UI now idles properly. Terminals detach from their PTY
  stream while hidden (background tab of a pane, or the whole browser tab
  hidden) and repaint from the daemon's replay when shown again — a hidden
  terminal no longer receives and parses every output byte. Visible terminals
  render on the GPU (`@xterm/addon-webgl`, DOM-renderer fallback). The status
  ripples/pulses are finite (~30 s / ~1 min after a status change) instead of
  animating forever, and the ports/env (5 s) and git status/diff (10 s) polls
  stretch 12× while the window is unfocused, snapping back on refocus. Agent
  processes and PTYs are untouched by all of this — pausing is viewer-side
  only.
- Battery, daemon-side: the 3 s agent-title refresh stat-guards the transcript
  and skips the 128 KiB read when unchanged; PTY log writes coalesce on a
  100 ms flush instead of one synchronous write per output chunk; session logs
  are now actually capped at `logMaxBytes` (the config existed but was never
  enforced — logs grew without bound), rotating to the newest half; the status
  detector compiles its regexes once instead of per chunk; and the WS gateway
  stops JSON-encoding output for streams whose last viewer detached.
- Replayed terminal history no longer re-executes OSC side effects: a stale
  OSC 52 copy can't clobber the clipboard and stale colour-query replies are
  never written into a working agent's stdin; a re-attach also repaints the
  buffer from scratch instead of appending the replay to what it showed.
- Status detection no longer sticks on green: agent status is now driven by
  the agent's own hooks instead of scraping the terminal. For Claude Code the
  daemon installs Stop / Notification(permission_prompt, idle_prompt) /
  UserPromptSubmit / PreToolUse hooks (verified against 2.1.219) whose helper
  reports to a new nonce-gated `POST /agent-signal` endpoint (protocol 9.4);
  the old regex detection remains as a fallback until a session's first
  signal. Existing accounts pick the hooks up at the next daemon boot.

### Changed

- `PROTOCOL_VERSION` → **10.0**: a deliberate major bump (the 6.0/8.0
  pattern) so every connected daemon auto-upgrades at the next handshake —
  this release's hook-driven status detection and archive-kills-live
  behaviour live daemon-side, and a 9.x daemon would leave sessions stuck
  green. Rolls up the unreleased 9.3/9.4 additions (`POST /agent-signal`,
  archive accepting live sessions).

- Archiving is one gesture for any session: the ⋯/right-click menu offers
  Archive on live agents and terminals too — the daemon kills the session as
  part of archiving (still a reversible hide; unarchive brings it back
  resumable), so there is no kill-first dance and no confirmation dialog.
  Protocol 9.3.
- Kill lost its confirmation dialog too: it only stops the agent process (the
  conversation stays resumable), so the menu action now fires immediately.
