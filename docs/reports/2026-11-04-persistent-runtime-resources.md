# Persistent runtime resource baseline — 4 November 2026

The latest calibrated macOS sample completed at **one and ten idle shell
runtimes**. At ten, owner self CPU was **0.968% of one core**, with another
**1.231%** recorded for their reaped children. Owners recorded **21.73 interrupt
wakeups per second** in total. The fifty-runtime step was refused by the existing
memory admission guard; no fifty-runtime native measurement exists yet. See
“Calibrated native counters” below for method and limits.

The earlier fifty-runtime observation used **3,355 MiB of summed owner RSS** in the
settled measurement. Their median controller re-adoption took **402 ms**. The
estimated owner CPU was **3.1% of one core**, but the process-time display precision
allows roughly five percentage points of aggregate uncertainty at this count and
sample length. This establishes a repeatable fixture baseline, not completion of
the production resource acceptance gates.

The original measurements through “Opt-in fixture regression ceilings” predate
the verified-TTY cache optimisation described under “Subsequent scan optimisation”;
they remain historical baseline evidence.

## Environment and method

- macOS 26.5.2, Darwin 25.5.0, Apple M4 arm64; Node 22.21.1; ten logical CPUs;
  24 GiB RAM.
- An active development workstation, with existing swap usage of 3.17 GiB before
  the experiment. Host-wide memory pressure and unrelated work were not isolated.
- Current 0.4.0 development source, bundled by the existing runtime fixture.
  Each owner ran one plain `/bin/sh` with a sanitised environment and a temporary
  home. No real provider, provider sidecar, installed service or production daemon
  was started.
- Owners were added cumulatively to reach 1, 10 and 50, with at most four concurrent
  launches. Before each scale step and batch, the harness checked memory headroom,
  estimated 100 MiB per additional owner and retained at least the greater of
  4 GiB or 20% of host memory. These are experiment admission guards, not measured
  capacity guarantees. The macOS percentage is a coarse memory-pressure indicator.
- The final run waited 15 seconds after initial attachment, then sampled cumulative
  CPU time over ten seconds. RSS came from `ps`; numeric descriptors came from
  `lsof`, excluding pseudoentries for working directories, executables and mappings.
- `RuntimeConnections` and `RuntimeReconciler` performed three controller replacements
  per scale, using their normal bounded discovery and authenticated adoption. The
  timing includes controller acquisition, reconciliation and continuity assertions;
  it excludes outgoing drainage and full daemon/process startup.
- Cleanup required all tracked owners and shells to have exited. The fixture
  retains its files if cleanup is uncertain. No fixture processes remained after
  the measurements; final host memory headroom was 48%.

The test is [idle-baseline.test.ts](../../packages/daemon/test/runtime/resources/idle-baseline.test.ts),
with probes in [metrics.ts](../../packages/daemon/test/runtime/resources/metrics.ts).
It is opt-in and writes its structured results only after cleanup succeeds,
including partial measurements and recorded regressions when a threshold fails:

```sh
PUDDLE_TEST_RUNTIME_RESOURCES=1 \
PUDDLE_TEST_RUNTIME_RESOURCE_REPORT=/tmp/puddle-runtime-resources.json \
node node_modules/vitest/vitest.mjs run \
  packages/daemon/test/runtime/resources/idle-baseline.test.ts
```

## Settled observation

Observed at 2026-11-04 15:41 UTC. The test passed in 84.19 seconds.

| Runtimes | Owner RSS total, MiB | Owner RSS median / max, MiB | Shell RSS total, MiB | Owner CPU, % of one core | Owner plus exited-child CPU, % of one core | CPU display-resolution margin, percentage points |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 112.8 | 112.8 / 112.8 | 2.3 | 0.10 | 0.10 | approximately 0.10 |
| 10 | 766.1 | 71.2 / 101.5 | 12.5 | 0.40 | 0.40 | approximately 1.00 |
| 50 | 3,355.4 | 66.2 / 103.8 | 61.5 | 3.09 | 2.69 | approximately 4.98 |

Every owner had **23 numeric descriptors** and every shell had **four** at all
three scales. At 50 runtimes that is 1,150 owner descriptors plus 200 shell
descriptors, distributed across separate processes.

| Runtimes | Re-adoption samples, ms | Median, ms | Maximum, ms |
| --- | --- | ---: | ---: |
| 1 | 27.3, 20.1, 18.4 | 20.1 | 27.3 |
| 10 | 105.1, 90.0, 82.1 | 90.0 | 105.1 |
| 50 | 401.6, 455.8, 392.7 | 401.6 | 455.8 |

RSS is a sum of process resident sizes: shared pages may be counted more than
once, while compressed or reclaimed pages can lower individual observations.
These totals are unsuitable as estimates of unique physical allocation.

The terminal-owner monitor polls every three seconds and runs scoped `ps` probes.
The final measurement therefore also used `ps -S`, whose documented macOS behaviour
adds exited children to the parent's CPU time. It still excludes live children at
the sample boundaries and all controller/daemon CPU. Ordinary and `-S` observations
are sequential, and their displayed CPU times have 10 ms precision per process.
The 50-owner combined estimate falling below the owner-only estimate is within
those measurement limitations; it does **not** show negative or negligible child
overhead. The margin above allows one displayed tick per owner, is not a statistical
confidence interval, and does not cover every source of sampling skew.
Linux `ps` may display only whole seconds. At 50 owners that permits a
500-percentage-point aggregate margin over ten seconds, making such a CPU sample
unusable for a low-overhead regression budget. The harness records each process
counter's displayed precision instead of assuming the macOS resolution.

## Why settling matters

Two earlier exploratory runs used only two seconds of settling. Both passed,
in 53.55 and 54.10 seconds. They measured owner CPU only and are not equivalent
to the final method:

| Runtimes | Owner RSS range across early runs, MiB | Owner CPU range, % of one core | Largest re-adoption sample, ms |
| --- | ---: | ---: | ---: |
| 1 | 75.4–75.5 | 0.70–0.80 | 23.6 |
| 10 | 811.4–938.4 | 3.50–3.52 | 116.4 |
| 50 | 2,796.4–3,921.5 | 15.55–21.89 | 1,045.5 |

The reduction after longer settling shows that the short window was sensitive to
startup and subsequent housekeeping. The runs do not isolate a single cause.
Memory pressure, collection timing and concurrent workstation activity also make
RSS and adoption latency variable.

## Opt-in fixture regression ceilings

Use these as preliminary investigation thresholds for this plain-shell fixture,
under the final 15-second settling method. They are not user capacity promises or
budgets for real providers. The opt-in test enforces RSS and adoption thresholds,
and descriptor thresholds when that probe is available. These checks were added
after measurement; replaying all three runs through the limit checker passed.

| Runtimes | Summed owner RSS ceiling, MiB | Maximum controller re-adoption ceiling, ms |
| --- | ---: | ---: |
| 1 | 192 | 100 |
| 10 | 1,536 | 300 |
| 50 | 6,144 | 2,500 |

- RSS ceilings round up approximately 1.5 times the largest observed total,
  including the exploratory runs. A separate **192 MiB per-owner** threshold
  would expose a concentrated increase hidden by the aggregate.
- **CPU and wakeup budgets remain unapproved and unenforced.** The current short
  quantised CPU observation does not support a defensible low-overhead ceiling;
  collect longer or higher-resolution samples before approving one.
- Adoption thresholds exceed twice the largest observed sample, rounded upward
  to permit ordinary scheduling variation. Only nine measurements per scale exist;
  they do not establish a reliable tail percentile.
- Proposed descriptor ceilings are **32 per owner** and **eight per plain shell**,
  against measured values of 23 and four. Provider-specific descriptors need their
  own measurements.

Before treating these fixture thresholds as CI or cross-platform release gates, repeat the final method
on a controlled runner and establish the expected variation. No memory or CPU
ceiling should be extrapolated from this fixture into a supported host session
count.

## Subsequent scan optimisation

Each runtime monitor now retains its last verified TTY. A steady refresh uses one
bounded `ps -t` scan, instead of a root lookup followed by a TTY scan. Every result
must still contain the exact root on that TTY. PID/generation changes, missing or
moved roots, failed inspections and disposal invalidate the cache. The
three-second polling interval and child-exit notification behaviour are unchanged.

The focused suites passed **44 tests**, including real foreground-agent recognition
and notifications across daemon replacement. Run them with:

```sh
node node_modules/vitest/vitest.mjs run \
  packages/daemon/test/pty/foreground-process.test.ts \
  packages/daemon/test/sessions/terminal-agent-monitor.test.ts \
  packages/daemon/test/runtime/controller/terminal-agent.test.ts
```

This verifies the reduced steady subprocess count and preserved behaviour. The
later native-counter sample below includes this change, but its method differs;
no isolated CPU, memory or wakeup saving is claimed.

## Subsequent aggregate buffer limits

Runtime transport now shares independent **64 MiB / 256-frame** budgets for
incoming partial frames and queued outgoing frames across every runtime socket
in one process. An incoming body reserves capacity before allocation. Completion,
failure and close release it; queued writes release on their callback or close,
including late callbacks without double release. Existing per-frame and
per-connection limits still apply. Capacity exhaustion closes only that connection;
it does not stop the runtime or prevent its PTY from draining.

Daemon terminal views share three independent pools:

| Pool | Charged capacity | Behaviour |
| --- | --- | --- |
| Snapshots/checkpoint reads | Eight simultaneous reads, each reserved at six times the 8 MiB frame limit plus 256 bytes | Reserves before reading; additional viewers reconnect. |
| Replay and batched output | 32 MiB and 16,384 retained entries | Accounts for retained text and output-copy space; disconnects the overflowing viewer. |
| Input and terminal actions | 64 MiB and 256 actions | Accounts for retained text/paste buffers; even zero-byte resize actions consume capacity. |

Input and pending-read reservations remain held after viewer disposal until their
promises settle. Discarded input is never dispatched on reconnect. Output exhaustion
does not consume input capacity. These are conservative charged-buffer ceilings,
not preallocated memory or guarantees about total RSS, garbage collection, provider
memory, WebSocket buffers or the sum across independent owner processes.

The **38 focused tests** passed, covering aggregate reservations, partial frames,
slow writes, concurrent viewers, snapshot races and reentrant disposal, plus real
isolated owner/controller replacement and daemon WebSocket continuity. Run:

```sh
node node_modules/vitest/vitest.mjs run \
  packages/daemon/test/runtime/resources/budget.test.ts \
  packages/daemon/test/runtime/controller/terminal-buffers.test.ts \
  packages/daemon/test/runtime/controller/terminal-view.test.ts \
  packages/daemon/test/runtime/controller/terminal-gateway.test.ts \
  packages/daemon/test/runtime/transport/framing.test.ts \
  packages/daemon/test/runtime/transport/connections.test.ts \
  packages/daemon/test/runtime/host.test.ts \
  packages/daemon/test/runtime/daemon-adoption.test.ts
```

The original scale benchmark predates these limits. The native-counter sample
below includes them; sustained active-output and slow-consumer measurements remain
outstanding.

## Calibrated native counters

Observed at 2026-11-04 17:33 UTC on the same workstation. The fixture now settles
for fifteen seconds and samples for thirty seconds. It compiles a small C probe
against the installed public macOS SDK and reads `proc_pid_rusage` for the exact
fixture PIDs. The probe calibrates the machine's Mach-time conversion against
`CLOCK_PROCESS_CPUTIME_ID` and `getrusage` before accepting any samples. This run's
timebase was 125/3: self CPU converted to 50.025 ms, versus 50.013 ms and
50.007 ms from the independent clocks; reaped-child CPU converted to 50.470 ms,
versus 50.469 ms from `getrusage`. Five controlled sleeps recorded five interrupt
wakeups and zero package-idle wakeups.

The [raw report](persistent-runtimes/resources/2026-11-04-native.json) retains
decimal uint64 counters, PID start identities, and before/after timestamps around
each read. Subtraction and conversion use BigInt before producing millisecond
deltas. PID reuse, missing processes, decreasing counters and overlapping sample
intervals fail the measurement. Per-process rates use those timestamp brackets;
the brackets describe read timing, not a confidence interval or effective CPU
accounting resolution. Existing coarse `ps` observations remain separate.

| Runtimes | Summed owner RSS, MiB | Owner self CPU, % of one core | Owner reaped-child CPU, % of one core | Owner interrupt wakeups/s | Controller with harness CPU, % of one core | Median re-adoption, ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 67.0 | 0.268 | 0.135 | 2.87 | 0.041 | 28.1 |
| 10 | 668.2 | 0.968 | 1.231 | 21.73 | 0.036 | 106.7 |

Every owner retained 23 descriptors and every shell four. The shells recorded
zero self CPU and wakeups over these windows. Controller-plus-harness interrupt
wakeups were 1.27/s at each scale. All sampled groups recorded zero package-idle
wakeups; this is a measured zero, not unavailable data. Reaped children exclude
live children, including the separately sampled shells. These columns do not
establish complete process-tree totals. Interrupt/package-idle counters are
specific wakeup categories, not all scheduler wakeups or energy consumption.
The controller shares the Vitest process and measurement orchestration; its
reaped compiler/probe children are excluded from the controller summary. It is
not an isolated daemon measurement.

The complete test **failed after 98.20 seconds** because memory admission refused
forty additional owners before the fifty-runtime step. Headroom after the ten-owner
sample was approximately 36% of 24 GiB. The unchanged reserve is the greater of
4 GiB or 20% of physical memory, plus 100 MiB per additional owner. Both completed
scales met the existing RSS, descriptor and adoption ceilings, and cleanup
confirmed every tracked owner and shell had exited before writing the partial
report. No retry with weaker admission was performed. The subsequent helper
verification passed two tests, strict test TypeScript, lint and formatting.

The probe lives under `test/runtime/resources/native/`; its calibration gate can
also be run independently with `PUDDLE_TEST_RUNTIME_NATIVE_METRICS=1` and
`native-probe.test.ts`. Linux and machines without the SDK compiler explicitly
report native counters unavailable. The baseline now records completion/failure
metadata as well; the captured report above predates that reporting-only addition.
One partial run does not establish variation at fifty runtimes, cross-platform
behaviour or production budgets. CPU/wakeup ceilings remain unset pending that
evidence.

## Subsequent owner screen bounds

Screen parsing no longer waits for atomic snapshot writes. Separate pools charge
16 MiB/2,048 parser actions and 16 KiB/64 capture actions; read pressure cannot
consume the input pool. Two transient operations share a 96 MiB charged allowance,
with at most 32 metadata-only waiters and no queued serialised snapshot payloads.
Saves coalesce, and final screen files are capped at 4 MiB. Preflight bounds the
pinned serialiser before allocation, selecting whole old scrollback lines while
preserving complete visible normal/alternate buffers and mouse modes. Oversized
viewports refuse capture instead of truncating ANSI.

Capture queues synchronously at its replay cursor boundary. This prevents a slow
capacity wait or partially parsed write from mixing newer output into an older
snapshot. Actual parser overflow makes the screen explicitly unavailable while
live output/log draining continues; last-good disk screens are retained, with a
key-only unavailable tombstone after the emulator exits. All 104 focused tests
passed, including actual owner/PTY, segment-switch, viewer replay, mouse, slow-save
and ordering regressions; source/test TypeScript and lint passed.

These are owner-local charged allowances, not preallocated RAM or a whole-host
envelope. Historical orphaned temporary files still need bounded inventory.
The native measurements above predate this change; no measured savings or
throughput claim follows from these bounds.

## Remaining resource gates

Native macOS interrupt/package-idle wakeups are now measured at one and ten
plain-shell runtimes; fifty runtimes and equivalent Linux measurements remain
open. Provider CLI/sidecar overhead, isolated controller/daemon RSS and CPU,
service-manager overhead, active output and slow
consumers, host-wide retained storage and native-provider workloads remain open.
This report supplies a repeatable baseline and proposed
monitoring limits; it does not claim all resource acceptance gates are met. Its
RSS limits are distinct from the implemented transport/viewer buffer capacities.
Those capacities do not establish a total host memory ceiling or replace workload
measurements.
