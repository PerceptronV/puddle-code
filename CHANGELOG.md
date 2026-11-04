<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Changed

- Add application protocol 25.7 private host-update control with bounded correlated requests, host-wide lease checks, durable operation coalescing and freshly inspected runtime-default dispatch. Reuse the existing local/SSH installer for preparation; lost replies never replay updates.

- Verify host-update supervision against the actual daemon PID and user service manager, binding service identity to inspection evidence and refusing stale or unknown supervisor markers.

- Combine host-update compatibility, interruption and fresh capacity checks into one inspection, withholding approval evidence for blocked or changing work and sharing the existing bounded storage probes.

- Inventory daemon-update interruption impact through existing terminal, notebook, compilation and puddlang managers, retaining idle kernels and watchers in the review and distinguishing replacement execution from previously observed work.

- Declare supported runtime majors in passive host-release metadata and inspect staged update compatibility against existing owners; runtime compatibility covers both IPC and retained state without requiring matching release versions.

- Package a one-shot runtime updater that shares runtime supervision and the canonical installer, preserves service configuration during exact activation and verifies the selected generation before reporting completion.

- Add durable host-update operation bookkeeping with exact approval/dispatch identities, bounded history and worker fencing that preserves uncertain outcomes after crashes; reuse shared host claims and private record storage.

- Separate host-release staging from activation in the shared installer, binding exact generations to verified tree receipts while keeping running services untouched during staging.

- Select daemon and runtime builds independently through the shared host bootstrap; runtime installation leaves services running, and opt-in launches pin the selected build while version inventory reports its separate protocol.

- Install host releases into immutable generations, preserving pinned files on same-version repairs and retaining the previous selection when staging fails; read installed versions from release metadata.

- Include the `puddler` executable and runtime protocol metadata in host release archives, sharing the existing bundle configuration, pinned Node and native modules.

- Organise persistent runtime code and tests by ownership, transport, execution, state, daemon control and lifecycle, retaining stable executable entry points.

### Fixed

- Resolve SSH-delivered checksum paths before changing the installer working directory.

- Collect ended independent runtime service registrations through a bounded durable queue, preserving live owners and pinned data and recovering safely from lost removal responses.

- Retain main-terminal titles in opt-in independent owners across daemon replacement, keeping offline native-switch titles on their exact placements and preserving user overrides.

- Preserve foreground-agent hints and completion alerts for opt-in independent terminal runtimes across daemon replacement, without changing terminal placement identity or adopting native conversations.

- Recover current agent attention alerts from opt-in independent runtimes across daemon replacement, retaining exact destinations and suppressing duplicate, stale and deliberately stopped alerts.

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

