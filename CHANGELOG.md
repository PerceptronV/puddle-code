<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

Persistent runtimes and cockpit-managed host updates are mandatory standard behaviour for the planned 0.4.0 release, with no enable/disable setting or selectable legacy backend. Native platform, SSH/logout/reaper, provider, reboot, remaining recovery and resource-budget acceptance are still required; this changelog does not certify those release gates.

### Changed

- Give each live agent or terminal runtime one independent `puddler` owner for its PTYs, provider sidecars and retained state. Use independent ownership by default for interactive/headless agents, plain shells and code-execution terminals; keep the legacy backend solely for internal migration fixtures.
- Adopt surviving owners after daemon replacement, retaining shell state, native conversation switches, captured environment, titles, colours, attention alerts and port forwarding. Commit ordered observations before acknowledgement, fence duplicate launches and uncertain input, and preserve accepted agent turns without replaying the programmes that requested them.
- Bound aggregate runtime IPC and terminal-view buffering, keeping separate input, output and snapshot capacity. Exhaustion closes the affected connection without stopping its PTY or replaying work. Cache each terminal's verified TTY to reduce steady process observation to one scoped scan while preserving foreground hints and child-exit detection.
- Package daemon and runtime software in immutable release generations with independently selected defaults, pinned helpers and verified archive/tree receipts. Initialise the runtime default on fresh installation and legacy daemon-only upgrades, preserve existing runtime pins, and share an installation lock whose exclusion survives child commands outliving their parent.
- Add local/SSH `install runtime`, `upgrade runtime` and durable `puddle updates` inspection/cancellation. Select software for future launches without restarting existing runtimes; compatible component release versions may differ, while runtime compatibility covers both IPC and retained state. Preserve supported controls across compatible application-major advances, while unknown or incompatible hosts remain refused.
- Add cockpit **Settings → Host** controls to inspect versions, prepare daemon/runtime software, review exact impact and explicitly apply updates. Share host-owned release discovery and per-window offers, retain last-known results across daemon replacement and require separate consent for daemon-owned terminals, kernels, watchers or programmes that must stop.
- Route daemon, runtime and combined updates through one coordinator and independently supervised updater, reusing the canonical installer. Check exact release receipts, runtime compatibility, database migration support, capacity and service identity; drain application writers, retain shutdown checkpoints and require fresh runtime adoption before declaring completion.
- Support explicit update recovery through CLI and cockpit, including labelled recorded status and local/SSH offline continuation. Verify consumed steps rather than replaying uncertain commands; retain execution exclusion until worker descendants have ended. Start an installed daemon's selected service without reinstalling it, and handle supported stopped-daemon, systemd start-limit, idle launchd and connector-start recovery through exact recorded attempts.
- Add local/SSH `pudl` and MCP controls to inspect retained programme outcomes and explicitly read or discard an exact result. Record the choice atomically, permit bounded reclamation and never resume interrupted programmes or replay prompts.
- Add a local/SSH session **Runtime** inspector and explicit restart onto the installed build. Show affected agent/shell tabs and lost process state, bind consent to the exact runtime and native conversation, and require confirmed clean exit before replacement. Software installation alone never restarts an existing owner.
- Add separately host-approved remote-browser maintenance grants. Exact admitted device, registration and grant identities are independently checked by the daemon; participating browsers can prepare, review and apply host updates or request online recovery through the same coordinator. Pairing grants no maintenance, status is redacted, and offline continuation stays local/SSH. Application protocol is 26.1, remote protocol is 5 and runtime protocol remains 1.0.
- Permit labelled host-session runtimes only for explicit `nohup`/`none` installations when no user service manager is available. Verify boot identity and process-group separation before launch. Attached-daemon closure may leave owners alive or host policy may reap them; reconnect adopts survivors or reconciles ended owners according to auto-resume settings. Limited/unknown owners block daemon replacement, and managed updates require a usable service manager.
- Coordinate local/SSH daemon removal with remote disablement, exact service teardown and runtime retention/stop review. Retain independent owners by default and require separate interactive consent or `--stop-runtimes` for termination. Preserve data, pinned builds, credentials and grants; deliberate installation restores completed removals from retained definitions without restarting a healthy daemon. Interrupted removal/restoration observes recorded actions rather than repeating them.
- Add explicit local/SSH data purge with separate runtime-stop consent, fresh dirty/unpushed worktree review, a verified reboot barrier for unresolved provider descendants and bounded resumable deletion. Preserve permanent locks and recovery anchors, fence installation until completion and never continue automatically after an uncertain reply.
- Collect verified unused release builds through mandatory bounded maintenance. Recheck references, quarantine exact inodes and preserve live builds, recovery evidence, session history and conservative rollback pins. Retire obsolete runtime references only after verified reboot evidence and completed update jobs only after process/service checks; interrupted cleanup never repeats uncertain service actions.

### Fixed

- Keep terminal screen parsing responsive during slow snapshot writes. Bound queued work and serialised screens, preserve replay ordering and complete visible terminal modes, and report a canonical-screen gap instead of silently presenting dropped input as complete.
- Bound raw runtime history by both bytes and file count. Repeated terminal generations cannot create unlimited tiny log files; reaching the cap preserves live output, checkpoints and recording for already admitted streams.
- Bound retained programme results across the host and reserve capacity before sending a prompt. Confirmed refusals release unused capacity, uncertain work stays protected, and bounded maintenance reclaims only consumed terminal outcomes without deleting their audit or replaying execution.
- Carry exact daemon-update interruption approval through CLI/background launches and desktop windows. Inspect stopped older services before compatibility negotiation, and preserve independent runtime continuity instead of warning that every modern update interrupts all sessions.
- Move live independent agent runtimes between accounts through the existing native-conversation migration flow. Require confirmed owner/sidecar exit, recheck authority before replacement and preserve copied state after an uncertain admitted launch.
- Retain application storage when runtime connection drainage fails during daemon shutdown, preventing outstanding callbacks from accessing a closed database.
- Resolve SSH-delivered checksum paths before changing the installer's working directory.
- Stop healthy terminal snapshot saves from incorrectly marking a runtime's state as unsaved.
- Honour disabled PTY recording for daemon-generated terminal notes.
- Install managed agent hooks atomically with literal path quoting, preserving custom status-line commands when migrating the managed dispatcher.
- Wait for the Codex lifecycle app-server to exit during cleanup, forcing termination if it ignores the graceful stop.
