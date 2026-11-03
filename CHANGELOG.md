<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Fixed

- Restore port discovery and local/SSH forwarding for adopted runtimes, keeping provider-internal ports hidden and invalidating stale placement scans.

- Route adopted runtime shell, capture and stop/archive controls through their owners, retain explicit stop intent across disconnects, and protect worktrees until clean shutdown is confirmed.

- Attach terminal viewers to experimental independent runtimes across daemon restarts, with fenced input/resize, bounded snapshot buffering and separate historical checkpoints.
- Reconnect experimental runtime control streams without replaying work, and recover final exits or confirmed owner loss under the exclusive ownership claim.
- Reconcile experimental runtime journals across daemon restarts, atomically recovering native switches, captured environment and private turn results before acknowledging observations.
- Preserve experimental independent runtime ownership during daemon boot/shutdown, and reject legacy controls that could falsely resume or stop an unreconciled runtime.
- Honour disabled PTY recording for daemon-generated terminal notes.
- Install managed agent hooks atomically with literal path quoting, preserving custom status-line commands when migrating the managed dispatcher.
- Wait for the Codex lifecycle app-server to exit during cleanup, forcing termination if it ignores the graceful stop.

