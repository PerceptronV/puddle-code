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

### Fixed

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
