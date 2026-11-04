<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Changed

- Add explicit host-approved remote-browser maintenance grants, separate from ordinary pairing. Approved devices can review and apply host daemon/runtime updates through the existing coordinator, with independent daemon permission checks and aggregate status. Application protocol 26.0 and remote protocol 5 require matching protocol generations across clients, daemon, connector and relay; runtime protocol remains 1.0.

- Record immutable release receipts during ordinary bootstrap using the existing staging verifier. Verify, extract and hash one private archive snapshot, preserve prior receipts on reuse, and retain completed release evidence after publication failures so verified unreferenced builds can later be collected safely.

- Reduce steady terminal-agent polling to one scoped process scan per runtime by caching its verified TTY. Keep the detection cadence and background-child exit handling; invalidate the cache on terminal replacement, failed inspection or shutdown.

- Initialise the mandatory runtime default during a fresh daemon install or legacy daemon-only upgrade. Validate the runtime before selecting the daemon, retain independently pinned runtime versions on later upgrades and preserve selected generations after interrupted bootstrap.

- Preserve host update, recovery, removal and runtime inspection controls when a compatible application protocol advances to a new major. Keep unknown and incompatible hosts refused independently of feature availability.

- Integrate explicit local/SSH data purge with separate runtime-stop consent, a kernel reboot barrier for unresolved provider descendants, fresh dirty/unpushed worktree review and bounded resumable deletion. Preserve permanent locks, pinned releases and private recovery records; fence installation until purge completion, and stop automatic continuation after uncertain replies.

- Allow independent runtimes on explicitly unsupervised hosts with a visible host-session lifetime. Verify process-group separation and recorded kernel boot identity before launch, preserve shell state across controller replacement, and block daemon updates for limited or unknown lifetimes without interrupting those owners.

- Add bounded, durable release collection with fresh reference checks, exact inode quarantine and continuation after interrupted deletion. Keep the collecting helper and all retained runtime/update references pinned; public scheduling and obsolete-reference retirement remain in progress.

- Add an internal release-collection review that preserves selectors, retained runtime/helper builds, update recovery evidence and removal history. Bound metadata inspection, refuse unknown references and identify verified unreferenced generations older than seven days; deletion and coordinated purge remain in progress.

- Continue partially disabled remote registrations during explicit daemon removal. Reuse profile writer locks and disablement, bind continuation to the exact active removal, and observe already-disabled registrations and lost replies without rewriting their files or repeating requests. Preserve credentials and grants through removal/reinstallation.

- Resume interrupted daemon/connector unregistration between disablement, failed-state reset, definition deletion and manager reload. Record each step through the existing removal journal, verify consumed effects without repeating commands, and sync reviewed definition deletion before proceeding. Retain older coarse records without inventing continuation steps.

- Coordinate local/SSH daemon removal with durable remote disablement, verified service teardown and an exact runtime retention/stop review. Retain independent runtimes by default; add `--stop-runtimes` for explicit termination. Preserve pinned releases and data for reinstallation, inspect exact completion attempts after lost replies, and prevent persistent installations from using legacy deletion. Coordinated purge remains unfinished and refuses before mutation.

- Restore recorded, completed daemon service removals through `puddle install daemon` before treating retained release files as an installed service. Capability-detect the trusted local/SSH helper, continue only exact recorded attempts, inspect lost replies and reuse authenticated startup without restarting an already-connected daemon. Public removal orchestration and full retained-runtime acceptance remain in progress.

- Add internal deliberate restoration of removed host service definitions, preserving saved bytes without overwriting existing files or links. Verify recorded reload/enable attempts without replay, retain the removal fence until configuration and shutdown checks pass, and hand off to ordinary startup without restarting runtimes. Public CLI reinstallation remains in progress.

- Block daemon startup, host update writes and installation while recorded removal remains unresolved. Retain read-only status and allow cancellation only before any service action was attempted, preserving one private cancelled review. Keep removal-only hosts out of legacy bootstrap fallback; CLI removal/reinstallation remains in progress.

- Record internal host-removal service intent and original definitions using the updater's shared durable action writer. Continue only unstarted steps, verify consumed stops and unregistration without replay, and retain private evidence after lost replies or storage failures. CLI removal/reinstallation and purge integration remain in progress.

- Add checked internal daemon/connector service teardown for host removal, retaining update and installer exclusion across offline runtime handling. Preserve service definitions until shutdown is confirmed, observe lost stop replies without repeating them, and require current controller ownership and supervisor absence before completing unregistration. CLI uninstall and purge integration remain in progress.

- Add the internal runtime retain/stop phase for host removal, sharing existing ownership, reconciliation and serial controls. Refuse stale interruption reviews and pending stop replay; keep CLI uninstall and purge integration as follow-up work. Correct healthy terminal snapshot saves incorrectly marking a runtime as unsaved.

- Verify runtime service removal through a reachable supervisor before completing cleanup. Reinspect historical removal records, retain unresolved cleanup across daemon replacement and keep delayed runtime launches fenced.

- Share an installation file lock between host installers and daemon startup that releases when all process references close. Retain exclusion while child commands survive parent termination, preserve the lock inode and refuse ambiguous legacy directory locks instead of advising blind deletion.

- Recover loaded but idle launchd services during explicit startup or accepted update recovery. Retain controller exclusion, unload only the observed idle registration and bootstrap the validated plist; stop on lost unload replies or changed evidence without repeating the command.

- Allow explicit update recovery after a confirmed connector-start failure, reusing the existing service checks and durable attempt journal. Recheck the selected build and stopped service before startup, observe healthy replacements without restarting them and require fresh acceptance after uncertain starts.

- Recover a stopped daemon's systemd start limit during explicit startup or accepted update recovery. Reset only the exact unit, retain controller exclusion and repeat current service/database/runtime checks before starting; leave lost reset replies inspectable without retrying or starting.

- Add explicit recovery continuation from a disconnected local/SSH cockpit (application 25.17), reusing the trusted helper and pinned recovery worker. Cancel uncommitted dispatch when browser participation ends, preserve accepted independent work, reject older staged dispatchers and inspect lost replies without repeating an update.

- Show recorded host-update status in local/SSH cockpits while the daemon is unavailable (application 25.16), reusing the trusted helper and preserving browser authority checks. Label recorded completion and the last connected version explicitly, disable offline mutations, and discard replies after cancellation or reconnection. Explicit offline cockpit continuation remains in progress.

- Add a session Runtime inspector and explicit restart on the installed build (application 25.15, local/SSH). Show affected agent/shell tabs and warn about lost shell jobs. Bind approval to the exact runtime, conversation and installed release, require clean exit before normal resume, and reject stale approvals or changed authority without replaying uncertain work. Installing runtime software continues to leave existing processes running.

- Add Settings → Host update controls for local/SSH targets: inspect versions, prepare daemon/runtime software, review exact interruption impact, explicitly apply and observe supported live recovery. Offer newer releases once per component and window, retaining dismissal across reconnects. Lost replies refresh status without repeating activation. Offline/legacy cockpit recovery remains in progress.

- Add host-owned version inventory and coalesced latest-release discovery (application 25.14), reusing CLI/desktop lookup code. Preserve the 30-minute cadence and timestamped last-known results across daemon restarts, report runtime builds without private session details, and stage from the target host's release source. Discovery does not install or restart anything.

- Add the local/SSH cockpit host-update gateway (application 25.13), reusing existing staging, exact impact approval and live recovery. Bind update actions to browser and cockpit authority, preserve other windows when one is revoked, and observe lost replies without replay. Offline cockpit recovery remains in progress; remote/runtime protocols are unchanged.

- Start an installed daemon's selected service during local/SSH launch without reinstalling or replacing its build. Share authenticated readiness with stopped-host upgrades and route approved legacy launcher updates through the common upgrade entry. Preserve update/controller exclusion, require explicit recovery for interrupted activation and observe lost startup replies without retry or fallback; packaged platform and abrupt-kill recovery acceptance remain in progress.

- Route ordinary daemon upgrades on supporting hosts through the existing runtime-update coordinator, sharing staging, impact review and observation after lost replies. Ask for exact interruption consent for daemon-owned work, preserve independently hosted agents, and refuse legacy installer fallback after uncertain modern updates or unavailable modern coordination. Launcher/cockpit integration and packaged platform acceptance remain in progress.

- Add `puddle updates [user@host] --operation <id> --continue` (application 25.12) for explicit continuation of interrupted daemon updates, including through trusted local/SSH access while the daemon is unavailable. Reuse the pinned recovery worker and shared metadata readers; report durable acceptance separately from verified completion and never automatically repeat an uncertain dispatch. Cockpit integration and remaining failure/platform acceptance are still in progress.

- Add internal recovery after confirmed replacement-daemon loss, checking current SQLite/WAL schema and runtime ownership before a separately recorded start. Preserve later runtime launches in fresh adoption proof; never restore old application data or repeat a start from a failed connection alone. Public CLI/cockpit continuation remains in progress.

- Continue internal host-update recovery across partial attempts without losing earlier step intent. Verify an already-running replacement daemon and finish pending connector startup without repeating successful selections or service starts; public CLI/cockpit continuation remains in progress.

- Add an independently supervised internal recovery worker for updates interrupted after daemon shutdown, preserving one-shot dispatch and step intent, verifying attempted selections without replay and retaining exclusion while recovery-command children remain alive. Public CLI/cockpit continuation remains in progress.

- Share exact shutdown and checkpoint verification with stopped-daemon recovery, retaining controller exclusion after lost stop replies while independent runtimes continue; reject changed service definitions, stale controllers and incompatible candidates before further activation.

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

