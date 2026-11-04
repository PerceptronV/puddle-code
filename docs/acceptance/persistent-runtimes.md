# Persistent-runtime acceptance

The [roadmap](../roadmap/persistent-runtimes.md) defines the complete acceptance
matrix. The current implementation is an experimental owner/client foundation;
production `SessionService` still uses daemon-owned PTYs. Passing this document's
foundation checks does not establish seamless production upgrades.

## Automated foundation checks

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
PUDDLE_TEST_RUNTIME_SUPERVISOR=1 node node_modules/vitest/vitest.mjs run --project daemon packages/daemon/test/runtime/supervisor-live.test.ts
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


`runtime/reconcile.test.ts` injects a database failure midway through a native
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


`runtime/recovery.test.ts` now exercises a dropped control stream followed by
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


`runtime/terminal-gateway.test.ts` now attaches real WebSockets to an isolated
production daemon controlling the fake-provider owner. Two daemon lifetimes
preserve the main PID, shell variable and terminal input; `stty size` verifies
resize delivery. A native switch closes stale viewers, the new placement receives
live output, and the old placement restores its own checkpoint without later
output or write access. A third daemon boot after owner exit restores the final checkpoint
without restarting the agent. `runtime/terminal-view.test.ts` checks snapshot cursor
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

`runtime/session-controls.test.ts` exercises the real isolated daemon and a
separate runtime owner through HTTP and WebSockets. Concurrent shell creation
produces distinct terminal ids; profile capture changes reach the owner; new
shells use its current gate; purge returns the exact cleared count. Individual
shell termination leaves the owner alive. After the main terminal exits, archive
still stops the remaining shells and requires a complete clean exit record.
`runtime/controls.test.ts` covers a lost stop acknowledgement, stop intent before
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
`runtime/processes.test.ts` covers live inspection, unbound/ended owners,
disconnection, immediate event invalidation and owner loss during a pending scan.
Network tests cover overlapping scans without stale cache replacement. Cached
owner references are bounded to 256 placements.

The final runtime/network/profile-authority run passed 63 tests in seven files.
Typecheck, scoped lint and formatting passed. This verifies loopback forwarding
through the production daemon; installed SSH upgrades and native provider ports
still require their platform acceptance runs.

`runtime/launcher.test.ts` now dispatches an owner through a deterministic fake
supervisor after asserting that launch context and SQLite intent already exist.
Retirement and supervisor collection refuse the held launch claim. A deliberately
lost supervisor reply still produces one owner, with the expected baseline/captured
environment precedence and pinned shell hooks. Shutdown preserves an unconfirmed
launch for reconciliation without another dispatch; missing pinned hooks fail.

`runtime/terminal-launch.test.ts` starts the real isolated daemon with the explicit
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

`runtime/agent-launch.test.ts` now exercises HTTP interactive-agent creation using
the opt-in launcher, preserving the main PTY PID and a fake provider's sidecar
through daemon replacement and an exact native switch while disconnected. An
explicit kill/resume creates a new owner with the exact switched ref. A preset-id
provider seeds its ref before dispatch and retains `native_sync: fallback` when
it has no supported lifecycle channel. No installed agent is used.

`runtime/session-refs.test.ts` checks private launch identity, exclusion of earlier
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

`runtime/code-launch.test.ts` exercises a real programme through the production
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

`runtime/programme-launch.test.ts` now runs actual puddlang runners against real
isolated daemons with fake interactive/headless providers. Each admitted ask has
a durable operation mapping before the provider sees it. Daemon replacement
leaves the accepted turn running; the replacement recovers its private result
while the programme stays interrupted. Explicit cancellation cancels only the
selected turn and leaves an attached runtime alive; a later programme attaches,
completes another ask and explicitly stops it. Provider and terminal PIDs persist.

`runtime/programme-turns.test.ts` discards a real owner's accepted reply, then
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

`runtime/programme-spawn.test.ts` holds a fake supervisor dispatch after durable
launch intent, then cancels the programme before allowing the dispatch to finish.
The recorded owner exits cleanly and receives no ask. A manual resume creates a
replacement; after daemon replacement, retrying the old programme cancellation
leaves that replacement running. The ownership record still names the old runtime.

`runtime/programme-spawn-store.test.ts` injects an ownership-write failure and
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

`runtime/turn-retention.test.ts` exercises 300 sequential turns through durable
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

`runtime/theme.test.ts` runs a real PTY child that repeatedly issues OSC 10/11
queries and records the returned colours. It verifies launch-time answers,
continued answers without a controller, retained PID/colours on adoption,
placement-fenced changes and the same responder in extra shells. Reconciliation
tests discard an applied colour-update acknowledgement and prove inspection
avoids another change; simulated older state without theme support is skipped.
`runtime/terminal-launch.test.ts` sends existing cockpit WebSocket theme reports
through a real isolated daemon, replaces the daemon and checks that colours stay
intact until a new report, then verifies the latest pair seeds a resumed owner.
The focused colour/protocol/daemon run passed 18 tests. This proves PTY response
and routing behaviour, not installed providers' automatic theme selection.
The runtime/PTY/protocol/profile-authority regression run passed 242 tests in
47 files, with one native supervisor test skipped. Typecheck, scoped lint and
formatting passed. The first probe run timed out because its report file was not
private; setting the fixture's mode to `0600` corrected the test.

`runtime/notifications.test.ts` uses a real owner and replacement daemons, with a
private connector sink that records notifications without sending real pushes.
Offline transitions and a native switch produce one current alert with the exact
new placement; a second daemon does not repeat it. A subsequent live completion
produces a fresh id, deliberate stop stays silent, and a normally exiting child
retains its final alert through owner retirement. Exact-condition preview reads
reject a superseded attention id. The initial exit fixture stalled because its
interactive shell ignored SIGTERM; a file gate now makes the shell exit zero.

`runtime/notification-delivery.test.ts` covers coalescing 100 conditions to one,
failed delivery-claim writes, daemon replacement, five-minute expiry, explicit
stops, replacement owners, previews racing resumed work/newer attention/shutdown,
and waiting for reconciliation. Private metadata stores no preview bodies. The
runtime/protocol/profile-authority regression run passed 172 tests in 41 files,
with one native supervisor test skipped. Eight existing agent-preview/connector
tests also passed. The final focused run passed 12 tests, including a 35-owner
case proving an unavailable first page cannot starve ready owners. Typecheck,
scoped lint and formatting passed.
These tests do not prove native provider hooks, operating-system notification
delivery or terminal-launched-agent monitoring; those remain release gates.

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
