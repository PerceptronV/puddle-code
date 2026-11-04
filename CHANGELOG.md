<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Fixed

- Preserve cockpit terminal colours in opt-in independent owners, answering agent colour queries during daemon outages and synchronising new reports after reconnection.

- Reclaim consumed private results in opt-in independent runtimes, preserving unread outcomes and monotonic turn identities; refuse new asks before dispatch when protected results fill retention.

- Persist programme spawn ownership before dispatch, fence cancelled launches and keep cleanup from stopping a later runtime in the same placement.

- Route opt-in headless agents and programme asks through independent runtimes, persisting exact turn identities before dispatch and preserving accepted turns across daemon replacement without replaying programmes.

- Preserve opt-in independent code-execution terminals and their managed run directories across daemon replacement; explicit terminal resume never repeats the programme.

- Extend opt-in independent runtimes to interactive agent creation and exact-conversation resume, preserving provider sidecars across daemon replacement and refusing ambiguous native-ref recovery.

- Add opt-in independent terminal creation/resume with durable launch intent, dispatch fencing and pinned shell hooks; uncertain supervisor replies never trigger duplicate execution.

- Restore port discovery and local/SSH forwarding for adopted runtimes, keeping provider-internal ports hidden and invalidating stale placement scans.

- Route adopted runtime shell, capture and stop/archive controls through their owners, retain explicit stop intent across disconnects, and protect worktrees until clean shutdown is confirmed.

- Attach terminal viewers to experimental independent runtimes across daemon restarts, with fenced input/resize, bounded snapshot buffering and separate historical checkpoints.
- Reconnect experimental runtime control streams without replaying work, and recover final exits or confirmed owner loss under the exclusive ownership claim.
- Reconcile experimental runtime journals across daemon restarts, atomically recovering native switches, captured environment and private turn results before acknowledging observations.
- Preserve experimental independent runtime ownership during daemon boot/shutdown, and reject legacy controls that could falsely resume or stop an unreconciled runtime.
- Honour disabled PTY recording for daemon-generated terminal notes.
- Install managed agent hooks atomically with literal path quoting, preserving custom status-line commands when migrating the managed dispatcher.
- Wait for the Codex lifecycle app-server to exit during cleanup, forcing termination if it ignores the graceful stop.

