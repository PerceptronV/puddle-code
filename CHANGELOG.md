<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Changed

- Record durable host-update step intent before stopping services, selecting releases or starting replacements, retaining attempted versus unstarted work after lost replies and storage failures for explicit recovery.

- Inspect recorded host-update status through local/SSH access when the daemon cannot connect, reusing the existing host-control helper and shared private-ledger validation without starting services or replaying updates.

- Add `puddle updates --operation <id> --recover` (application 25.11) to verify completed host updates after lost replies without repeating installation or service commands. Record the updater's process group before activation; retain maintenance and recovery while its commands may still be running. Incomplete installations and recovery with the daemon stopped remain pending.

- Share host-update completion checks with recovery inspection, verifying exact selected releases, fresh runtime adoption and replacement service configuration without replaying installation or service commands. Keep recovery unresolved until an explicit supported recovery action supplies the remaining worker-lifetime checks.

- Reject daemon updates whose declared database migration ceiling cannot read the current host schema, and recheck the shutdown checkpoint before selection. Refuse opening a newer database before changing journal mode or application data; keep runtime-only updates independent of daemon storage.

- Compose daemon-update maintenance through private host control, draining application writers before pausing runtime observation while independent agents keep running. Preserve maintenance after uncertain dispatch, resume observations after fenced recovery, and drain log-retention copies before replacement.

- Add application protocol 25.10 exact interruption approval for daemon-owned work during host updates. Preserve staged work for separate confirmation, invalidate consent when release or impact changes, and retain matching evidence in the private updater; cockpit integration remains in progress.

- Hold later programme requests during maintenance while accepted independent agent turns continue. Drain notebook startup through cell dispatch, preserve submitted execution until an update is accepted, and discard unsent programme requests on shutdown without replay.

- Extend reversible maintenance drains to runtime controls, native conversation capture, marker synchronisation and compilation. Finish admitted work without cancellation, reject new commands without replay, and recover current watched state when a pause is released.

- Carry exact connector process and service evidence into daemon updates, preserve its existing supervisor configuration, and verify replacement before final daemon adoption. Keep uncertain connector changes recoverable without replay; production upgrade integration remains in progress.

- Add application protocol 25.9 private connector process inspection, binding daemon-update preflight to fresh pinned release metadata and refusing unknown or changing connector inventory without exposing profile configuration.

- Add ordered final-update admission drains, retaining maintenance after uncertain dispatch and passing exact outgoing controller/service evidence to the worker. Let admitted runtime launches finish before pausing observation; production daemon-update composition remains in progress.

- Compose daemon and combined update-worker transactions around exact supervisor shutdown, drained runtime checkpoints, shared installer selection and fresh adoption verification. Preserve existing service configuration and retain uncertain partial updates without replay; public daemon dispatch remains gated on final approval and recovery integration.

- Bind signal-driven update checkpoints to the outgoing daemon PID and controller, rejecting stale worker instructions while keeping ordinary shutdown available when update metadata is missing or damaged.

- Add application protocol 25.8 fresh private adoption observations for daemon updates, verifying exact staged executables, controller replacement and checkpointed runtime continuity through host control and authenticated HTTP authority.

- Persist bounded runtime ownership checkpoints for accepted daemon updates after shutdown drains and SQLite flush, retaining controller ownership on publication failure and preserving exact runtime builds and committed cursors.

- Make independent runtimes the daemon launch default, sharing service-manager discovery with update preflight and refusing unavailable supervision without falling back to daemon-owned sessions. Keep the legacy backend only as an internal test override.

- Add local/SSH `install runtime` and `upgrade runtime` through the shared host-update coordinator, plus `updates` inspection and exact pre-dispatch cancellation. Runtime software changes preserve running builds; bare upgrades include an installed runtime default. Keep component transports open until installation finishes.

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

- Retain application storage when runtime connection drainage fails during daemon shutdown, so outstanding callbacks cannot access a closed database.

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

