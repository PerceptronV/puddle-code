<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- Captured session environment (SPEC §4): `export`s typed in a session terminal
  (or made by `source`d scripts, `nvm use`, venv activation) persist per
  session and are re-injected into new shell tabs, agent restarts/resumes, and
  respawns after a daemon restart. Capture is a prompt hook injected into
  session shells (zsh via a ZDOTDIR shim, bash ≥ 4 via `--rcfile`; other
  shells and macOS bash 3.2 degrade to no capture), reporting over an OSC 7733
  side-channel the daemon strips before recording — values never reach
  terminal logs, replay, or viewers, and live only in the daemon's SQLite.
- `GET /api/sessions/:id/env` (captured var names + byte sizes — never values)
  and `DELETE /api/sessions/:id/env` (clear). Protocol **8.0 → 9.0**.
- Per-profile `captureSessionEnv` setting (default on) with a toggle under
  Settings → Sessions; an `env` strip under each session pane listing captured
  var names; and a confirmed "Clear captured env" session-menu action.
- Manual acceptance script `docs/acceptance/captured-env.md`.
