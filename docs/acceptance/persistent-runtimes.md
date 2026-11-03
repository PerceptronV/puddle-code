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
and formatting passed. Production command routing, confirmed-loss recovery,
programme result consumption and retention reclamation remain outstanding.

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
