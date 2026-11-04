# Persistent-runtime acceptance

The [roadmap](../roadmap/persistent-runtimes.md) defines the complete acceptance
matrix. Persistent ownership is required standard behaviour for every user in
0.4.0, without an enable/disable option. Implementation remains in progress:
daemon composition now defaults to installed independent runtimes. Hosts without
a usable service manager currently refuse new launches; their detached/attached
lifetimes remain a release blocker.
Passing these foundation checks does not establish seamless production upgrades.

## Automated foundation checks

`updates/preflight/connector.test.ts` covers absent versus offline/ambiguous state,
old managers, wrong nonces, readiness, pinned paths and metadata mismatch.
`connector-process.test.ts` builds the actual connector entry point, copies Node
into an isolated generation and checks its live private replies against public
release metadata, including the bundle's `--version` smoke path. It runs no user
profiles/providers or installed services, and confirms process exit before removing
its executable tree. The connector's own inspection suite rejects malformed and
oversized requests while preserving manager operation. Combined preflight rejects
changed connector observations and rechecks owner inventory after the final probe.
These tests prove inspection, not connector supervisor replacement or full upgrades.

`updates/maintenance/pause.test.ts` checks ordered admission drains, reverse release,
shared deadlines, failed phases and irreversible shutdown. The launcher suite uses
an actual isolated shell: an admitted launch finishes before discovery/reconciliation
pause, the same owner executes while its database cursor is held, and observations
catch up after release without another launch. Coordinator tests verify final
inspection occurs after drainage, changed authority/impact aborts before dispatch,
lost dispatch replies retain maintenance, and recovery releases admission only after
the execution claim is free. The worker supervisor suite verifies outgoing evidence
is durable before dispatch and a stale controller cannot consume approval. These
use explicit internal composition; production still needs all daemon participants,
connector replacement and adjacent-work interruption approval before enablement.

`updates/worker/daemon/execute.test.ts` uses the actual installer, SQLite checkpoint
and controller claims with simulated supervisor commands and a mocked adoption
verifier. Daemon-only and combined selection follow stop/select/start/verify; lost
stop, selection or startup replies and changed configuration retain recovery state
without replay. The separate adoption tests below exercise the real verifier.
`updates/worker/daemon/stop.test.ts` drains an actual isolated daemon with a live
shell owner, proves the worker holds the released controller claim during selection,
and adopts the same runtime afterwards. Worker isolation tests reject a wrong PID,
same service or nested systemd termination scope.

`host/supervision/replacement.test.ts` checks both service command families,
configuration changes, stale invocations and unknown launchd errors. The native
`replacement-live.test.ts`, gated by `PUDDLE_TEST_RUNTIME_SUPERVISOR=1`, passed on
macOS 26.5.2: a uniquely named temporary KeepAlive job stops through `bootout`,
retains its exact plist/custom environment, and starts through `bootstrap`. Its
registration and process must be gone before fixture files are removed. It runs
no installed daemon or provider. These checks do not establish native Linux or a
complete packaged daemon/connector upgrade; public daemon dispatch remains disabled.

`packages/daemon/test/updates/checkpoints/adoption.test.ts` combines an isolated
shell owner with staged metadata and private control/HTTP fixtures. It checks
new controller epochs, exact generation paths, launch identities, committed cursors,
settled placement bindings and confirmed final exits. A worker observation must
carry a new nonce and pass both live control authority and authenticated HTTP checks;
stale receipts and changed PID records fail. A blocked SQLite flush cannot refresh
a receipt, and additive metadata remains included in its checkpoint digest without
breaking compatible readers. These fixtures inject executable paths
and do not prove packaged daemon activation. Shared tests gate nonce requests on
application 25.8 and require an exact operation id.

`packages/daemon/test/updates/checkpoints/store.test.ts` covers accepted dispatch
identity, bounded inventories, immutable private checkpoint files, cursor/schema
evidence and final exits during drainage. A real SQLite reader blocks the WAL
flush and must prevent checkpoint publication until released. A failed checkpoint callback retains
the controller claim. An isolated daemon holds client work across shutdown,
selects an accepted worker hand-off through ordinary `stop()`, publishes only after
drainage and preserves a shell owner for replacement adoption. The replacement's
ordinary shutdown does not reuse or overwrite that checkpoint. The separate
`updates/worker/shutdown.test.ts` covers exact controller/PID and dispatch/revision
binding, execution phases, runtime-only exclusion, recovery fencing and missing or
damaged metadata. These private metadata fixtures never dispatch an installed worker.
This is shutdown evidence; it does not establish update activation or verified
replacement receipt handling.

`packages/daemon/test/runtime/lifecycle/default-launch.test.ts` starts isolated
daemons without a runtime override. Missing supervision and missing installation
must refuse launch without a daemon PTY or prepared owner. A held service-manager
probe cannot dispatch after shutdown begins. These checks use fake probes and no
installed service. The separate `default-launch-live.test.ts`, gated by
`PUDDLE_TEST_RUNTIME_SUPERVISOR=1`, passed on macOS 26.5.2: a sanitised temporary
daemon with no runtime override resolves an installed fixture release, launches
one native launchd owner, and adopts the same live shell PID after daemon
replacement. It then stops the runtime and verifies its exact test registration
is absent. This does not prove transactional daemon upgrades or Linux lifetimes.

Client admission and shutdown checks:

```sh
node node_modules/vitest/vitest.mjs run packages/daemon/test/host/lifecycle packages/daemon/test/http/app.test.ts packages/daemon/test/pty/ws-gateway-output.test.ts packages/daemon/test/pty/shutdown.test.ts
```

These cover refused writes without replay, continued terminal output/status,
authenticated version inspection, bounded drains, stale pause releases and an
isolated temporary daemon retaining SQLite until admitted work settles. The PTY
spawn test uses a fake child; the daemon shutdown test starts no agents. They
establish client admission, not background-writer quiescence or upgrade adoption.
An injected runtime connection drain failure also verifies that shutdown remains
closed to requests while retaining SQLite for outstanding callbacks.

The lifecycle suite also checks coalesced upkeep, a four-worker sweep of 100 items,
bounded job counts and drain deadlines. Its temporary daemon holds a fake account
probe across shutdown and verifies the logged-in result in the reopened database.
The conversation-share suite holds status-triggered adoption across shutdown;
the onboarding-shutdown test rejects late watcher installation and callbacks.
These cover specific background writers, not a complete maintenance checkpoint.

`packages/daemon/test/sessions/conversation-catalogue.test.ts` additionally holds
adapter discovery and Git mapping across catalogue disposal, verifies that late
results cannot create placements or mark conversations missing, and checks that
disposal waits for in-flight helper reads without reinstalling watchers. Other
background writers and reversible update checkpoints remain separate gates.

Catalogue pause checks additionally verify a fresh post-release scan, replacement
watcher identity, and coalesced recovery when repeated cancellations occur before
the old discovery call settles. Paused scans do not advance missing observations;
disposing the catalogue remains irreversible even if an old hold is released.

`packages/daemon/test/runtime/controller/checkpoint.test.ts` exercises reversible
reconciliation pauses against an isolated owner. A shell increments its in-memory
counter while the daemon's committed cursor remains fixed, then retains the same
PID/counter after journal catch-up. A delayed event response cannot commit after
the pause, and releasing a hold cannot undo closure. This proves the reconciler's
checkpoint boundary, not the complete host update transaction.

Runtime transport connection tests pause discovery during an admitted attachment,
verify installation of its output listener, disconnect the viewer while paused,
then prove owner PID and shell state survive resumed discovery. Notification and
service-cleanup tests hold a preview or supervisor result across a pause and check
that the durable record stays pending until release and reinspection. These use
isolated owners and fake supervisor removals; no installed service is changed.

`packages/daemon/test/sessions/session-refs.test.ts` verifies that preset and minted
native-ref captures already in progress commit before shutdown finishes, that a
pending pre-spawn snapshot cannot start a child afterwards, and that coalesced late
recovery drains without admitting another scan. It uses fake adapters and real
temporary stores; no provider executable is launched or native conversation guessed.

The session-service suite also holds a direct native clear callback at its PTY
rebind boundary while shutdown begins. The drain must wait for its durable switch
event and preserve the PID/ref, while later provider callbacks are refused.

`packages/daemon/test/agents/accounts/observations.test.ts` holds login checks over
closure, serialises startup/login results, coalesces repeated exits, and retains
stored flags for absent binaries or failed probes. The daemon lifecycle and end-to-end
account/login suites verify that production composition drains these observations
before closing SQLite. Checks use fake adapters and never read credentials.

Run from the repository root with dependencies installed:

```sh
node node_modules/typescript/bin/tsc -b packages/shared packages/daemon
node node_modules/vitest/vitest.mjs run packages/shared/test/runtime.test.ts packages/daemon/test/runtime packages/daemon/test/db packages/daemon/test/agents
```

The isolated tests create private temporary homes and a bundled test owner. They
run `/bin/sh` with a sanitised environment and never launch the installed daemon,
desktop or a real provider CLI. The host suite checks shell PID and an in-memory
variable across controller replacement and controller `SIGKILL`; echo is disabled
so the proof cannot be satisfied by echoing the submitted input.

Journal checks cover disconnected shell exits, retained final records,
controller-specific acknowledgement boundaries, duplicate acknowledgement,
pagination, stale cursors, private record identity, encoded-byte/count limits,
stalled writes and disk failure/backoff. Event replay is observation recovery;
no test obtains continuity by replaying an agent command.

Provider fixtures exercise both interactive/headless resource preparation, exact
lifecycle events while disconnected, native conversation collisions, nonce/Origin
denials and installed-version fallback. A separate Codex fixture runs the real
adapter and proxy against a fake executable/app-server; its counter and PIDs
survive controller replacement. The fake app-server ignores SIGTERM so cleanup
must wait for the adapter's forced-exit fallback. These fixtures require no
installed provider CLI and do not prove a native provider's hook contract.

Turn-control fixtures deliberately stop reading the admission response before
dispatch, then replace the controller and recover the result while asserting a
single provider invocation. They also cover native identity changes, cancellation,
human takeover, owner exit, bounded UTF-8 replies and reserved journal capacity.
These checks do not yet cover a production puddlang run surviving/reconciling an
application upgrade; interrupted programmes must still never be replayed.

Helper checks run two different pinned builds through one reinstalled account
dispatcher and verify literal shell paths/arguments, bounded private manifests,
the selected Node executable and refusal to use fallback code when pinned files
are absent. Generated Claude/Gemini lifecycle and turn hooks run with replaced
account helpers; turn records stay in the owner's mutable directory and are
removed on control disposal. OpenCode loader selection and Claude status-line
capture/migration are covered separately. A live fake runtime verifies that its
provider control and PTY receive owned paths despite captured environment
overrides. These checks do not prove release-tree retention or native CLI loading.

Shell-observation checks send chunk-split OSC reports while the controller is
disconnected, adopt the same shell PID, recover private values/unsets/empty values
and cwd, and open a new shell with the current captured environment before any
daemon acknowledgement. Saved terminal logs/screens and ordinary inspection
must contain neither the value nor its base64 payload. Other cases exercise
capture disable/re-enable/purge, denied names, UTF-8/count limits, bounded warning
deduplication, journal pressure and coalescing across offered cursors without
crossing lifecycle/control barriers. Production settings and database application
are not covered until that integration exists.

Segment continuity uses a fake provider with two independent PTYs and two exact
native switches while its controller is absent. Gate files order output relative
to hook observations without replaying commands. The test verifies unchanged
main/shell PIDs and variables, retained mouse tracking/encoding, correctly
separated raw logs, historical checkpoints excluding later output, and final exit
checkpoints. Unit cases cover capture/write pressure, conservative byte/segment
budgets, malformed addresses and owner identity mismatches. Checkpoint gaps never
authorise using a different segment. Production placement binding, input fencing
across placement switches, retention and budget reclamation remain open.

## Native macOS supervision

From a logged-in macOS GUI user account with a working `launchctl gui/<uid>`
domain, enable the additional integration test:

```sh
PUDDLE_TEST_RUNTIME_SUPERVISOR=1 node node_modules/vitest/vitest.mjs run --project daemon packages/daemon/test/runtime/lifecycle/supervisor-live.test.ts
```

This creates two uniquely labelled temporary jobs: a runtime owner and a mock
daemon controller. It restarts the controller with `launchctl kickstart -k`,
checks that the controller PID and ownership epoch change, and verifies that the
runtime shell keeps its original PID and variable. Test executables and native
dependencies are staged outside Desktop/Documents so launchd does not depend on
terminal-granted directory access. The `finally` path removes both test jobs and
waits for runtime ownership to be released before deleting their files.

Recorded foundation verification, 2026-11-03: macOS 26.5.2, Node v22.21.1. The
runtime/shared/database/adapter run with this flag passed 202 tests in 29 files.
After the final first-conversation binding refinement, all 24 focused protocol,
journal and turn-control tests passed; typecheck, lint and formatting also passed.
The native test verifies separate launchd jobs, not a released daemon upgrade or
real provider sidecars.

After helper ownership/dispatch changes on the same platform, the broader run
passed 208 tests in 29 files, with the opt-in native supervisor test skipped.
The additional lifecycle and status-line cases passed in a 16-test focused run.
These results extend the helper evidence; they do not replace the earlier native
supervisor result or close the production release gates.

After private shell-observation retention and current-environment injection, the
runtime/shared/database/adapter suites plus `packages/daemon/test/pty` passed
297 tests in 39 files on the same platform; the opt-in native supervisor test was
skipped. Typecheck, scoped lint and formatting passed. This includes provider
control/main-PTY seed propagation and newly opened shells using observations that
the controller has not yet acknowledged.

After live-emulator/history separation, that same combined suite passed 302 tests
in 41 files, with the opt-in native supervisor test skipped. The final privacy
check also scans the separate `screens/` and `segments/` directories for captured
values and encoded payloads. This is fake-provider continuity evidence; it does
not prove real provider hook ordering or production placement adoption.

Placement-binding checks use a real isolated application database and fake provider.
They commit ordered native switches before binding the owner, deliberately leave
the binding response unread, reopen the database and replace the controller, then
verify identical PTY/sidecar PIDs and the retained shell variable. Stale commands
cannot write input, resize, create/kill shells, stop the runtime, start/cancel a
turn or change/purge captured environment. Deterministic fixture-only journal
gates also switch native refs while turn/capture/purge admission is awaiting
persistence; the resumed commands must fail without effects. Store tests cover
transaction rollback, immutable segment mappings, predecessor checks, closure,
retention and refusal to invent history for older experimental bindings.

The combined runtime/shared/database/adapter/PTY suite passed 306 tests in 42
files on macOS with the native supervisor test skipped. After adding the final
admission-race cases and immutable-conversation guard, the focused binding/store
suite passed all 12 tests. Typecheck and scoped lint passed. These checks do not
establish production SessionService adoption or installed-upgrade continuity.
The final runtime-only rerun passed 78 tests in 16 files, with the opt-in native
supervisor test skipped.

Boot ownership protection is now wired into the production composition root.
`runtime/daemon-ownership.test.ts` starts that daemon in a separate sanitised
process with a temporary application database and an independently owned shell.
It verifies successful inspection, rejected credentials and mismatched build
metadata across daemon start/stop cycles; the shell retains its PID and variable,
no interruption/resume events are invented. Authenticated observations now
commit and receive acknowledgement; rejected owners preserve the last committed
cursor. HTTP kill/resume/archive and legacy WebSocket controls reject
unreconciled external ownership. A snapshot-await race rechecks the same guard
before replay/resize. This still does not provide a usable external terminal attachment.

The runtime/session/PTY/host-control regression run passed 313 tests in 41 files
with the opt-in native supervisor test skipped. The final focused ownership,
store and gateway run passed 17 tests. Typecheck, scoped lint and formatting
passed. Installed upgrades and native provider/platform gates remain outstanding.


`runtime/controller/reconcile.test.ts` injects a database failure midway through a native
switch page and verifies complete rollback, including private environment and turn
state. Successful replay creates each placement/audit event once. It also covers
missing history, denied environment names, stale generations, premature owner
acknowledgement and the private result-retention bound.
`runtime/daemon-adoption.test.ts` completes a fake-provider turn and switches native
conversations twice while the controller is absent, then starts the real isolated
daemon. It checks exact recovered refs, private results, environment, committed
acknowledgement and live switch reconciliation across two daemon lifetimes. Main
PTY/sidecar PIDs and a shell variable survive; stale placement input is rejected
and the provider turn executes once. This is fake-provider reconciliation evidence,
not native provider or installed-upgrade acceptance.

The runtime/database/session/PTY/host-control regression run passed 332 tests in
44 files, with the opt-in native supervisor test skipped. Typecheck, scoped lint
and formatting passed. Production command routing, programme result consumption
and retention reclamation remain outstanding.


`runtime/controller/recovery.test.ts` now exercises a dropped control stream followed by
bounded reconnect, preserving the original shell PID and variable. Natural exit
retires the binding once; abrupt owner loss becomes interrupted only after the
exclusive claim is acquired. Tests fence delayed/unstarted launches, collect a
provider launch that failed before creating a PTY, retain interrupted private turn
outcomes and refuse incomplete journals. A failure in the second recovered page
rolls back both pages and emits no placement-switch notification. Real isolated
daemon boots verify natural exit with auto-resume enabled and terminal loss with
auto-resume both disabled and enabled. The enabled case still uses the current
legacy launch backend; it does not prove production persistent-runtime creation.
Supervisor registration cleanup and orphan-sidecar recovery remain release gates.

The expanded runtime/database/session/PTY/host-control suite passed 342 tests in
45 files, with the native supervisor test skipped. The final focused recovery and
daemon-adoption run passed 12 tests. Typecheck, scoped lint and formatting passed.


`runtime/controller/terminal-gateway.test.ts` now attaches real WebSockets to an isolated
production daemon controlling the fake-provider owner. Two daemon lifetimes
preserve the main PID, shell variable and terminal input; `stty size` verifies
resize delivery. A native switch closes stale viewers, the new placement receives
live output, and the old placement restores its own checkpoint without later
output or write access. A third daemon boot after owner exit restores the final checkpoint
without restarting the agent. `runtime/controller/terminal-view.test.ts` checks snapshot cursor
filtering, authority revocation during capture, native-switch/disconnect fences,
bounded queues, exit during capture and ordered Unicode paste chunks. A lost chunk
response abandons remaining input. Recovery tests also verify explicit selection
of the legacy backend after a later legacy resume, preserving historical identity.
Additional-shell/session controls, creation, notifications, ports, themes and
production retention remain integration gates.


The terminal integration regression run passed 348 tests, with one onboarding
watcher timeout and the native supervisor test skipped. The watcher passed in
isolation, then all 41 session-service tests passed together. The final focused
terminal/migration/reconciliation run passed 11 tests; the extended owner-exit
checkpoint test also passed. Typecheck, scoped lint and formatting passed.
Migration coverage deliberately leaves older historical generations unresolved
when only current live terminal evidence exists.

`runtime/controller/session-controls.test.ts` exercises the real isolated daemon and a
separate runtime owner through HTTP and WebSockets. Concurrent shell creation
produces distinct terminal ids; profile capture changes reach the owner; new
shells use its current gate; purge returns the exact cleared count. Individual
shell termination leaves the owner alive. After the main terminal exits, archive
still stops the remaining shells and requires a complete clean exit record.
`runtime/controller/controls.test.ts` covers a lost stop acknowledgement, stop intent before
dispatch, queued authority revocation and refusal to confirm incomplete cleanup.
Recovery tests suppress auto-resume after explicit stop intent; worktree tests
refuse forced pruning until clean exit is confirmed. Project archive stops
dispatching after request authority expires. Missing request authority fails closed.

The broader runtime/database/session/PTY/host-control/security/worktree regression
run passed 425 tests in 59 files, with the native supervisor test skipped. After
extending project-archive authority checks, the final seven-file session, route,
network and runtime-control run passed 110 tests. Typecheck, scoped lint and
formatting passed. The earlier run exposed a stale security mock and a test that
read the first PTY prompt frame before the complete prompt arrived; both fixtures
were corrected before the passing regression run. Native supervisor/provider and
installed-upgrade acceptance remain unverified.

The terminal gateway acceptance test now starts a real loopback preview server in
an extra runtime PTY. Two daemon lifetimes discover and forward the same server
PID and response. A native switch invalidates the old placement's port list and
forwarding, while the new placement keeps the listener. The fake provider's
internal sidecar port remains excluded, and ended owners expose no ports.
`runtime/controller/processes.test.ts` covers live inspection, unbound/ended owners,
disconnection, immediate event invalidation and owner loss during a pending scan.
Network tests cover overlapping scans without stale cache replacement. Cached
owner references are bounded to 256 placements.

The final runtime/network/profile-authority run passed 63 tests in seven files.
Typecheck, scoped lint and formatting passed. This verifies loopback forwarding
through the production daemon; installed SSH upgrades and native provider ports
still require their platform acceptance runs.

`runtime/lifecycle/launcher.test.ts` now dispatches an owner through a deterministic fake
supervisor after asserting that launch context and SQLite intent already exist.
Retirement and supervisor collection refuse the held launch claim. A deliberately
lost supervisor reply still produces one owner, with the expected baseline/captured
environment precedence and pinned shell hooks. Shutdown preserves an unconfirmed
launch for reconciliation without another dispatch; missing pinned hooks fail.

`runtime/lifecycle/terminal-launch.test.ts` starts the real isolated daemon with the explicit
runtime composition option. HTTP terminal creation produces an independent owner;
WebSocket input establishes a shell variable and cwd. Daemon replacement preserves
that PID and variable. Explicit kill/resume creates a different runtime and a fresh
shell; archive confirms clean shutdown. Fake supervision only establishes the
process and integration behaviour, not native systemd/launchd or installed upgrades.
Code-execution terminals joined this opt-in path in the subsequent verification
below, with durable managed-run retention and external exit observation.

The broader runtime/session/PTY/host-control run passed 349 tests in 50 files,
with the native supervisor test skipped. The final six-file launcher, supervisor,
shell-observation and code-terminal/provider run passed 35 tests. Typecheck,
scoped lint and formatting passed. Agent launch and code-run retention received
subsequent coverage below; default installed selection and native supervisor/provider
acceptance remain release gates.

`runtime/lifecycle/agent-launch.test.ts` now exercises HTTP interactive-agent creation using
the opt-in launcher, preserving the main PTY PID and a fake provider's sidecar
through daemon replacement and an exact native switch while disconnected. An
explicit kill/resume creates a new owner with the exact switched ref. A preset-id
provider seeds its ref before dispatch and retains `native_sync: fallback` when
it has no supported lifecycle channel. No installed agent is used.

`runtime/controller/session-refs.test.ts` checks private launch identity, exclusion of earlier
native ids and refusal of ambiguous or inconsistent discovery. The launcher test
also exercises a confirmed pre-agent failure with a preset ref: final observations
reconcile, exclusive retirement still applies and dispatch happens once. Journal
tests verify that native events alone cannot promote fallback synchronisation.

The runtime/session/provider/puddlang/PTY/database/host-control regression run passed
511 tests in 70 files, with one native supervisor test skipped. The final journal
regression passed all three tests. Typecheck, scoped lint and formatting passed.
This is fake-provider and deterministic-supervisor evidence; headless/programme
routing, default installed selection and native platform/provider checks remain
release gates.

`runtime/lifecycle/code-launch.test.ts` exercises a real programme through the production
compilation HTTP route and opt-in independent owner. Its PID and in-memory counter
survive daemon replacement. Seven subsequent runs trigger pruning without deleting
the surviving programme's managed directory. Explicit stop releases that exact
owner's retention reference; later pruning removes it. Terminal resume starts a
fresh shell without repeating the programme. Runtime-store tests inject a failure
into retention insertion and verify that the entire launch intent rolls back;
failed owner state keeps files protected. Supervision remains deterministic in
these tests, with no installed daemon or native service changes.

The broader runtime/session/compilation/database/host-control run passed 337 tests
and exposed one old-schema fixture that needed to drop the new table before
rewinding its schema version; one native supervisor test was skipped. After that
fixture correction, all 36 database/runtime-store/migration tests in six files
passed. The focused programme-continuity/store run passed 12 tests. Typecheck,
scoped lint and formatting passed.

`runtime/lifecycle/programme-launch.test.ts` now runs actual puddlang runners against real
isolated daemons with fake interactive/headless providers. Each admitted ask has
a durable operation mapping before the provider sees it. Daemon replacement
leaves the accepted turn running; the replacement recovers its private result
while the programme stays interrupted. Explicit cancellation cancels only the
selected turn and leaves an attached runtime alive; a later programme attaches,
completes another ask and explicitly stops it. Provider and terminal PIDs persist.

`runtime/controller/programmes/programme-turns.test.ts` discards a real owner's accepted reply, then
verifies committed-result recovery and one provider invocation. Duplicate
operation delivery, foreign profile scope and failed intent insertion cannot
dispatch a prompt. These tests cover deterministic providers, not native CLIs.

The broad runtime/programme/session/provider/database/host-control run passed 427
tests and found two tests still using the old internal control accessor; one
native supervisor test was skipped. Both tests now use the service readiness/ask
interface. The final programme/headless run passed 35 tests in four files and the
interactive control run passed 12 tests. Typecheck, scoped lint and formatting
passed. Durable spawn-operation ownership, private result reclamation, native
provider/platform verification and installed/default rollout remain gates.

`runtime/lifecycle/programme-spawn.test.ts` holds a fake supervisor dispatch after durable
launch intent, then cancels the programme before allowing the dispatch to finish.
The recorded owner exits cleanly and receives no ask. A manual resume creates a
replacement; after daemon replacement, retrying the old programme cancellation
leaves that replacement running. The ownership record still names the old runtime.

`runtime/controller/programmes/programme-spawn-store.test.ts` injects an ownership-write failure and
proves placement insertion rolls back. Duplicate/cancelled admissions cannot leave
a new placement or runtime intent. Undispatched spawns are excluded from boot
auto-resume, while explicit later resume remains ordinary session recovery.
The first store run exposed fixtures reusing incarnation ids; unique incarnations
corrected the fixtures and both store tests passed. The held-dispatch integration
passed, as did the earlier 59-test programme/launcher/session/migration run.
The broader runtime/programme/session/database/provider-control/host-control run
passed 343 tests in 55 files, with one native supervisor test skipped. Typecheck,
scoped lint and formatting passed. Native platform/provider verification and
installed/default rollout remain outstanding.

`runtime/controller/programmes/turn-retention.test.ts` exercises 300 sequential turns through durable
programme admission and consumption. It verifies unread/running protection,
worst-case escaped reply bytes, rollback after failed intent/observation writes,
conservative migration and monotonic identities even when the newest consumed
outcome is reclaimed. All six store tests pass. The actual-owner programme tests
verify that a recovered lost acknowledgement marks only its exact outcome
consumed, and that full unread retention refuses a new prompt before dispatch.
Consumption records an authorised daemon caller's read, not runner delivery.
Unread-result disposition, host-wide storage accounting and native acceptance
remain open; recent consumed-result reclamation alone does not close those gates.
The runtime/programme/database/session regression run passed 318 tests in 54 files,
with one native supervisor test skipped. The final six-test retention run,
typecheck, scoped lint and formatting passed.

`runtime/state/theme.test.ts` runs a real PTY child that repeatedly issues OSC 10/11
queries and records the returned colours. It verifies launch-time answers,
continued answers without a controller, retained PID/colours on adoption,
placement-fenced changes and the same responder in extra shells. Reconciliation
tests discard an applied colour-update acknowledgement and prove inspection
avoids another change; simulated older state without theme support is skipped.
`runtime/lifecycle/terminal-launch.test.ts` sends existing cockpit WebSocket theme reports
through a real isolated daemon, replaces the daemon and checks that colours stay
intact until a new report, then verifies the latest pair seeds a resumed owner.
The focused colour/protocol/daemon run passed 18 tests. This proves PTY response
and routing behaviour, not installed providers' automatic theme selection.
The runtime/PTY/protocol/profile-authority regression run passed 242 tests in
47 files, with one native supervisor test skipped. Typecheck, scoped lint and
formatting passed. The first probe run timed out because its report file was not
private; setting the fixture's mode to `0600` corrected the test.

`runtime/controller/notifications.test.ts` uses a real owner and replacement daemons, with a
private connector sink that records notifications without sending real pushes.
Offline transitions and a native switch produce one current alert with the exact
new placement; a second daemon does not repeat it. A subsequent live completion
produces a fresh id, deliberate stop stays silent, and a normally exiting child
retains its final alert through owner retirement. Exact-condition preview reads
reject a superseded attention id. The initial exit fixture stalled because its
interactive shell ignored SIGTERM; a file gate now makes the shell exit zero.

`runtime/controller/notification-delivery.test.ts` covers coalescing 100 conditions to one,
failed delivery-claim writes, daemon replacement, five-minute expiry, explicit
stops, replacement owners, previews racing resumed work/newer attention/shutdown,
and waiting for reconciliation. Private metadata stores no preview bodies. The
runtime/protocol/profile-authority regression run passed 172 tests in 41 files,
with one native supervisor test skipped. Eight existing agent-preview/connector
tests also passed. The final focused run passed 12 tests, including a 35-owner
case proving an unavailable first page cannot starve ready owners. Typecheck,
scoped lint and formatting passed.
These tests do not prove native provider hooks or operating-system notification
delivery; those remain release gates.

`runtime/controller/terminal-agent.test.ts` starts a fake recognised agent inside an
independent shell and another in an extra terminal tab. Real daemon replacement
retains the main shell/child PIDs, foreground hint and busy evidence; one idle
condition produced offline is delivered once to a private sink. Confirmed child
exit produces an alert while the shell remains running, clears the main hint
despite the extra agent, and creates no native conversation. Deliberate stop stays
silent. `pty/foreground-process.test.ts` checks bounded per-terminal process
inspection, invalid terminal names, changed roots and failed scans. The focused
runtime/process/legacy-monitor run passed 37 tests. The broader runtime/PTY/
protocol/profile-authority regression run passed 292 tests in 52 files, with
one native supervisor test skipped; typecheck, scoped lint and formatting passed.
Native provider process
recognition and Linux terminal selection still require platform acceptance.

`runtime/controller/terminal-agent.test.ts` also verifies main-terminal title recovery before
adoption and after an offline title change, excluding an extra tab's title.
`runtime/state/titles.test.ts` splits OSC 0/1/2 at every character boundary, including ST,
and checks de-animation, bounded partial state and reset across a native switch.
Journal tests coalesce 199 title changes without crossing the native boundary or
mutating an offered page. Reconciliation tests inject a stale-segment title and
verify atomic rollback, then recover both placements' titles while preserving user
and native names. The focused run passed 19 tests in four files.
The broader runtime/PTY/session/protocol run passed 299 tests in 52 files, with
one native supervisor test skipped. Typecheck, scoped lint and formatting passed.

`runtime/lifecycle/service-cleanup.test.ts` covers atomic queue admission/rollback,
migration from schema 38, failed receipt writes, protected owner claims, four
concurrent removals, a 32-owner unavailable page and shutdown during removal.
The real-daemon terminal test waits for automatic cleanup after explicit stop.
Supervisor tests cover launch/dispatch locks, foreign service targets, absent
registrations, lost replies and refusing ambiguous/failed inspection.

On macOS 26.5.2 with Node v22.21.1, the opt-in native supervisor test passed after
adding real owner stop/removal. It explicitly verifies that launchd `bootout`
succeeded before discarding its response; cleanup then inspects absence and
records completion without repeating the removal. The test retains the original
shell PID/state through controller replacement before that stop. All jobs and
homes are temporary; this is not installed-upgrade or native-provider evidence.
The local `launchctl` manual defines non-zero exit codes via `launchctl error`;
code 113 was checked with `launchctl error 113` and a unique nonexistent test
target. No parsing of launchctl's unstable diagnostic text is used. Systemd
absence checks require `LoadState=not-found`, `ActiveState=inactive` and
`SubState=dead`; see the [systemctl manual](https://www.freedesktop.org/software/systemd/man/latest/systemctl).
Linux supervisor execution remains a platform acceptance gate.
The final runtime/database regression run passed 197 tests in 46 files, with
the native supervisor test skipped there and passed separately. Typecheck,
scoped lint and formatting passed.

After grouping runtime source and tests by responsibility, the runtime/provider/
session regression run passed 437 tests in 68 files, with one native supervisor
test skipped. Typecheck, scoped lint and formatting passed. Fixture imports and
the acceptance commands above use the new paths; the `puddler` entry point is
unchanged.

Host release packaging uses the existing builder and native-module staging. Build
and run the packaged-owner test without launching the installed daemon:

```sh
node scripts/build-tarball.mjs --out-dir /tmp/puddle-host-release
PUDDLE_TEST_RUNTIME_RELEASE=/tmp/puddle-host-release/stage/puddled-v0.3.14 PUDDLE_TEST_RUNTIME_ARCHIVE=/tmp/puddle-host-release/puddled-v0.3.14-darwin-arm64.tar.gz node node_modules/vitest/vitest.mjs run packages/daemon/test/runtime/lifecycle/release.test.ts
```

Adjust the version and archive platform to the release being tested. Supplying
`PUDDLE_TEST_RUNTIME_ARCHIVE` exercises the real embedded installer with checksum
verification and `--no-supervisor` inside the isolated home. It forces a same-version
repair of each component separately while the owner has no controller. Each repair
first stages a verified generation and asserts that the selector is unchanged, then
activates the exact receipt without passing an archive or release source again. It
checks the unselected default and old bundle are intact, resolves the new runtime default and
verifies shell continuity after adopting again. Omitting that variable tests the
staged/extracted tree directly. The test uses the archive's
`puddler` wrapper, pinned Node and native modules, checks version/protocol metadata
and a side-effect-free version probe, then preserves the shell PID and variable
through controller replacement before explicit stop. It reuses existing isolated
runtime fixtures and sanitised environments. Both Linux and macOS host release
jobs run this test after building their archive.

Local verification on macOS 26.5.2/Node v22.21.1 built the complete darwin-arm64
archive, verified its SHA256 and runtime entries, extracted it, and passed the
packaged-owner test from that extracted tree. Existing daemon/connector version
and puddlang smoke checks passed too. This verifies packaging and private owner
continuity. The archive-install variant also passed on that macOS/Node combination,
preserving the original owner and shell through a same-version repair. Deterministic
CLI installation tests cover fresh/private homes, legacy permission migration,
healthy generation reuse, failed smoke/metadata/activation, competing installers,
legacy inventory and literal wrapper paths. Runtime-only tests verify shared-tree
reuse, independent selection, exact metadata/report agreement, no daemon probe or
supervisor mutation, and the shared bootstrap/inventory path. Launcher tests reject
missing, external and incompatible selections and verify that changing the default
during command construction cannot change the already pinned launch build or its
recorded protocol. Staging tests share the installation fixture and verify complete
tree fingerprints, permission/symlink/dependency changes, receipt/component mismatch,
checksum failure, explicitly unverified local inputs and activation after the source
archive is removed. SSH delivery tests use real shell execution in a temporary home
with relative copied archive/checksum paths. The staged packaged-owner variant passed
on macOS 26.5.2/Node v22.21.1. Full supervised upgrade transactions,
reference-aware collection and native provider/platform gates remain outstanding.

The private operation-store tests run with the normal daemon suite:

```sh
node node_modules/vitest/vitest.mjs run packages/daemon/test/updates/operations
```

They verify exact component stages, revision fencing, approval invalidation,
single-use dispatch, mutually exclusive workers, retained uncertainty, positive
recovery requirements, bounded history and fail-closed storage. Injected write
failures before/after rename prove that a replacement controller inspects the
persisted state rather than repeating dispatch. An isolated bundled child process
holds an actual SQLite OS claim; a competing worker is refused, SIGKILL releases
the lock, and a replacement still refuses to replay the consumed operation. This
child executes no installer or daemon. The runtime/operation regression run passed
200 tests on macOS 26.5.2/Node v22.21.1, with the packaged-owner and native-supervisor
opt-in tests skipped in that run. These tests establish bookkeeping and fencing,
not supervisor lifetime, host-impact authorisation or successful installed updates.

The worker suite under `test/updates/worker/` exercises exact activation through the
canonical installer, real generation selection and receipt verification, changed
candidates, false success output, lost activation replies and consumed dispatches.
Supervisor tests verify independent systemd/launchd definitions, pinned executables,
bounded lifetime, single dispatch and recovery fencing. These command-runner fixtures
do not prove native supervisor lifetime. The packaged-owner test above additionally
executes the actual archive's `host-update.mjs` for runtime-default repairs while the
original shell keeps its PID and variable; its supervisor dispatch remains a fixture.
Use a freshly built archive containing the updater and embedded installer for that
test. Daemon replacement, actual updater survival across native daemon/connector
restarts, host-impact approval and completed-job cleanup remain release gates.
The installation/updater and targeted runtime/storage/compilation regression runs
passed 148 tests across 18 files on macOS 26.5.2/Node v22.21.1. The host archive,
CLI and desktop bundles built successfully; archive smoke checks include the passive
updater version command. Loopback upgrade fixtures require socket permissions.

The compatibility suite under `test/updates/preflight/` verifies passive candidate
metadata, release-version skew, supported runtime majors, independent application
and remote checks, unknown owners, unavailable owners and inventory changes during
inspection. All 20 tests passed on macOS 26.5.2/Node v22.21.1, alongside the real
daemon ownership, terminal gateway and missing-agent regressions. A freshly built
0.4.0 test archive passed the packaged-owner test, including its passive capability
metadata and runtime-default update with the original shell PID and variable
intact. CLI and desktop builds passed. This establishes compatibility inspection
and runtime-default continuity; it does not establish full update preflight,
installed daemon replacement or the required standard backend rollout for 0.4.0.

The interruption inventory uses the existing managers rather than scanning for
process names or inferring live execution from session rows. The preflight,
compilation, puddlang, notebook and daemon-ownership/gateway checks passed 48 tests
on macOS 26.5.2/Node v22.21.1. Real temporary PTYs verify stable observations and
replacement under the same stream; installed Jupyter verifies idle state, new runs,
kernel restart and shutdown. Compilation tests include in-flight builds and failed
eager watchers; programme shutdown clears its runner inventory without replay.
These observations do not prove a quiescence barrier or authorise an interruption.

The combined inspection/storage/daemon-ownership regression run passed 53 tests
across nine files on macOS 26.5.2/Node v22.21.1. Capacity fixtures cover bytes,
inodes, unavailable/coalesced probes and persistence degradation during inspection.
Integrated tests bind evidence to exact operations/stages, reject impact changes
during inspection and exercise the durable store's stale-approval invalidation;
normal journal progress and changing healthy free space retain stable evidence.
TypeScript, scoped lint and formatting checks passed. Capacity checks neither
reserve space nor prove migration size, and these tests do not exercise staging
admission, host-authority approval or a quiescence barrier.

Supervisor inspection is included in the combined preflight. The host/preflight,
worker-dispatch and daemon-ownership regression run passed 65 tests across nine
files on macOS 26.5.2/Node v22.21.1. Fixtures cover invalid/shared/symlinked markers,
absent managers, stale PIDs, pending systemd reloads and changed invocation identity.
The separate native macOS test passed against a uniquely named temporary launchd
job, detecting its changed PID after restart and removing its registration:

```sh
PUDDLE_TEST_RUNTIME_SUPERVISOR=1 node node_modules/vitest/vitest.mjs run packages/daemon/test/host/supervision/inspection-live.test.ts
```

This test never starts the installed daemon. The inspection uses documented
`launchctl list` columns after verifying the caller's GUI manager and user, and
only exit status from `print`; it does not parse
diagnostic output. Systemd inspection uses the current `MainPID`, invocation and
control group ([property reference](https://www.freedesktop.org/software/systemd/man/latest/org.freedesktop.systemd1.html)).
The final targeted checks passed 31 deterministic tests plus the native test,
including refusal of same-labelled jobs in a different manager context and an
explicit absence check before removing the temporary job's files.
Native Linux inspection, the dispatched updater's own service isolation, recorded
restart targets and full daemon-upgrade verification remain unproven.

Private update-control verification on macOS 26.5.2/Node v22.21.1 passed 106 tests
across 15 files (updates, security, CLI preparation and shared schemas), followed by
28 checks across six files for authority, worker dispatch, launcher compatibility
and real isolated daemon/terminal continuity. The latter run includes two new
transport/dispatch expiry checks. The existing daemon restart fixture now verifies
that a private update operation retains its identity across controller replacement
and remains observable/cancellable while its independent shell stays alive.
Fixtures cover profile denial, independent lease renewal, concurrent callers,
authority expiry, stale fingerprints, changed connection generations and uncertain
stage/dispatch replies without replay. TypeScript, scoped lint/formatting and both
CLI and desktop builds passed. The coordinator's inspection and supervisor dispatch
are deterministic fixtures; these results do not prove actual runtime activation
through private control or complete daemon replacement. Public commands and cockpit
integration remain required for the standard 0.4.0 behaviour.

Runtime CLI integration passed 80 checks across seven files, covering local/SSH
private control, stage coalescing, changed leases/inspection, lost apply replies,
recoverable worker failures, exact cancellation and existing launcher handshakes.
The install command keeps its transport open until asynchronous installation ends.
The built CLI connection-lifecycle suite passed all five checks.

Native runtime-update verification passed on macOS 26.5.2/Node v22.21.1 with a
fresh local 0.4.0 archive (application 25.7, remote 4, runtime 1.0). This runs the
built CLI against a sanitised temporary installation and actual packaged daemon,
uses actual preflight and the pinned launchd one-shot worker, and checks the exact
verified runtime selection. Daemon PID, selected daemon generation and supervisor
metadata remain unchanged. The test explicitly removes its unique worker job and
proves registration absence before deleting the temporary home:

```sh
PUDDLE_TEST_RUNTIME_SUPERVISOR=1 PUDDLE_TEST_RUNTIME_ARCHIVE=/absolute/path/puddled-v0.4.0-darwin-arm64.tar.gz node node_modules/vitest/vitest.mjs run --root packages/cli --config vitest.e2e.config.ts e2e/runtime-update.test.ts
```

The archive needs its adjacent `.sha256` file. The packaged-owner continuity test
also passed with this new archive, preserving its PID and in-memory shell variable
through runtime-default replacement. These are separate checks: the native updater
test proves runtime selection through the public command, while the owner test
proves continued execution across selection/controller changes. Neither proves a
native daemon-update transaction, Linux supervision, provider acceptance or default
ownership rollout. Runtime removal and combined host transactions remain pending.

## Remaining release gates

Record platform, Node, release and provider versions with results. Run native
provider checks from a plain shell; never launch the production daemon from an
agent session. Retain logs and before/after identities for each result.

- Exercise actual systemd user services and an installed daemon upgrade on Linux;
  generated-unit tests alone are insufficient. Verify process/cgroup separation
  and clean removal of completed owner registrations.
- Exercise the real daemon's launchd restart and installed upgrade on macOS.
  Record main PTY, shell-job and provider-sidecar PIDs, a shell variable and cwd,
  then demonstrate continued work while the daemon is absent.
- Cover all supported providers in interactive and headless modes, including
  exact lifecycle changes and conversation collisions during controller outages.
- Exercise native hooks/plugins from pinned release trees, Codex's proxy and
  app-server, shell environment, mouse modes, snapshots and port ownership.
- Verify SSH persistent and attached-lifetime hosts, truthful capability reporting,
  lost replies, incompatible runtime versions and two competing controllers.
- Measure memory, CPU/wakeups, descriptors and adoption latency at 1, 10 and 50
  runtimes; set and enforce budgets before default enablement.
- Run real packaging/update failure, cockpit notification, relay authority,
  retention/removal and adjacent-execution cases from the roadmap's full matrix.

These gates remain open until their production paths exist and matching evidence
has been collected. A skipped native test, fake provider or generated supervisor
definition cannot satisfy a native/platform gate.
