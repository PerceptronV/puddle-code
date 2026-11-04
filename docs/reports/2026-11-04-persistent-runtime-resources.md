# Persistent runtime resource baseline — 4 November 2026

The latest calibrated macOS sample **passed at one, ten and fifty idle shell
runtimes**, with the production host memory allowance and controller acquisition.
At fifty, summed owner RSS was **2,669.14 MiB**, self CPU was **3.700% of one core**,
and reaped-child CPU was **4.908%**. Owners recorded **109.75 interrupt wakeups per
second**; median controller re-adoption took **416.26 ms**. All existing fixture
ceilings passed, and cleanup confirmed every tracked owner and shell had exited.
See “Completed calibrated run” for the results. Both earlier partial attempts and
the historical memory-guard refusal remain recorded below.

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
- CPU and wakeup ceilings were initially unenforced: the short quantised CPU
  observation could not support them. The later calibrated native observations
  now support the separate fixture thresholds below; coarse `ps` readings still
  do not substitute for calibrated counters.
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
behaviour or production budgets. At this stage, CPU/wakeup ceilings remained
unset pending further evidence.

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

## Current host-allowance composition

Observed at **2026-11-04 20:23 UTC**, using the same calibrated native probe,
15-second settling interval, 30-second sample, four concurrent launches and
unchanged experiment memory guard. The current production owner composition
included the durable host allowance, lazy screen geometry, shared screen work,
checkpoint ownership transfer, raw-log buffers, and transport decoding/retained
request accounting. Plain shells exercised this composition without running a
real provider, provider sidecar, installed service or production daemon.

The [new raw report](persistent-runtimes/resources/2026-11-04-host-allowance-native.json)
preserves both completed samples and the failure. Its
[provenance record](persistent-runtimes/resources/2026-11-04-host-allowance-native-provenance.json)
records source and executable fingerprints: the bundle was created at HEAD
`15decde` with then-uncommitted production wiring. Subsequent source edits did
not alter that frozen bundle. In particular, later provider bridge accounting
fixes are outside this measurement; no provider was exercised. The earlier
native artifact remains unchanged.

| Runtimes | Summed owner RSS, MiB | Owner RSS median / max, MiB | Owner self CPU, % of one core | Owner reaped-child CPU, % of one core | Owner interrupt wakeups/s | Median / maximum re-adoption, ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 77.72 | 77.72 / 77.72 | 0.166 | 0.071 | 2.83 | 23.92 / 24.36 |
| 10 | 778.25 | 77.70 / 79.33 | 0.815 | 0.649 | 23.70 | 95.55 / 99.19 |

Every owner had **26 numeric descriptors**, compared with 23 in the earlier
sample, and every shell retained four. Both completed scales passed the unchanged
RSS, descriptor and adoption ceilings. Shell RSS totals were 2.25 and 22.50 MiB;
the shells recorded zero self CPU and wakeups. Controller-plus-harness self CPU
was 0.025% and 0.018% of one core, with 1.27 interrupt wakeups/s at each scale.
All sampled groups recorded zero package-idle wakeups. These categories retain
the earlier method's process-tree and controller-isolation limitations.

Calibration again used Mach timebase 125/3. Converted self CPU was 50.053 ms,
versus 50.049 ms from the process clock and 50.047 ms from `getrusage`; converted
reaped-child CPU was 50.262 ms versus 50.261 ms. Five controlled sleeps produced
five interrupt wakeups and zero package-idle wakeups.

The test **failed after 95.30 seconds** while launching additional owners after
the ten-owner sample. `HostMemoryLedger.readGrant` raised `SQLITE_BUSY` through
`reserveRuntimeLaunchMemory` and the fixture's synchronous `admitFixtureOwner`.
This is a fixture admission failure before process dispatch, not evidence of
an interrupted existing owner or an exceeded memory ceiling. Production launch
orchestration catches unavailable admission and returns a retryable 503 before
dispatch; the harness currently propagates that contention. No fifty-owner
cohort was sampled. The last recorded headroom was **57% of 24 GiB**, and the
memory guard was neither weakened nor bypassed.

Cleanup confirmed every tracked owner had exited and every known shell was
absent before writing the report. A separate post-run check found all 21 sampled
owner, shell and controller PIDs absent, and the temporary executable bundle had
been removed. The preliminary sandbox attempt had failed on private Unix-socket
`EPERM` before any sample; it also cleaned up before the identical authorised run.

A bounded fixture-only retry now handles synchronous `SQLITE_BUSY` before
`launchOwner` returns, for at most five seconds with 25 ms waits. This preserves
exact grant observation, the existing four-owner concurrency and memory guard;
returned processes and readiness checks are never retried. A resample is still
required. This single
partial observation does not establish a memory, CPU or wakeup improvement over
the historical samples. CPU/wakeup ceilings were not yet enforced during this run.

### Controller-acquisition resample

The second host-allowance run began at **2026-11-04 20:34 UTC** from clean commit
`70f6cfd`, with the bounded fixture admission retry above. The
[second raw report](persistent-runtimes/resources/2026-11-04-host-allowance-native-resample.json)
and [source/bundle provenance](persistent-runtimes/resources/2026-11-04-host-allowance-native-resample-provenance.json)
are separate artifacts; the first partial run remains unchanged.

| Runtimes | Summed owner RSS, MiB | Owner RSS median / max, MiB | Owner self CPU, % of one core | Owner reaped-child CPU, % of one core | Owner interrupt wakeups/s | Median / maximum re-adoption, ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 78.45 | 78.45 / 78.45 | 0.030 | 0.088 | 2.07 | 25.70 / 31.13 |
| 10 | 712.48 | 69.94 / 77.67 | 1.460 | 0.848 | 25.40 | 96.41 / 110.75 |

Owners had 25–26 numeric descriptors, shells four; both completed scales passed
every existing fixture ceiling. Shell RSS totals were 2.25 and 17.42 MiB, with
zero sampled shell CPU/wakeups. Controller-plus-harness self CPU was 0.028% and
0.021% of one core, with 1.27 interrupt wakeups/s. All sampled groups again
recorded zero package-idle wakeups. Calibration passed at timebase 125/3:
50.021 ms converted self CPU versus 50.015 ms/50.011 ms from the two independent
clocks, and 50.236 ms reaped-child CPU versus 50.234 ms. Controlled sleeps again
recorded five interrupt and zero package-idle wakeups.

The harness failed after **99.42 seconds**. All fifty owners had passed the
launch/readiness loop, but the subsequent initial controller attachment raised
`SQLITE_BUSY` in the host ledger's `cache_size` pragma. No fifty-owner sample or
adoption timing was recorded. The fixture called `RuntimeConnections` without
the asynchronous controller acquisition that production already supplies;
production uses `acquireRuntimeControllerWhenAvailable` to bound this exact
pre-publication contention. The harness now passes that existing helper at both
initial attachment and timed re-adoption; it adds no product fallback or retry
of a dispatched process. Re-adoption timing includes any controller wait.

The unchanged memory guard admitted the cohort; last sampled headroom was 54%
of 24 GiB. Cleanup confirmed all tracked owners exited and all known shell PIDs
were absent. An independent post-run check again found all 21 sampled PIDs
absent and the temporary bundle removed. A further run is needed to collect
fifty-owner native measurements with the corrected controller composition.

### Completed calibrated run

The third host-allowance run began at **2026-11-04 20:38 UTC**, from clean commit
`2eba20b`. It **passed all three scales in 147.33 seconds** using the corrected
fixture admission and the existing production controller acquisition. No
product fallback, memory-guard relaxation, concurrency increase or retry of a
dispatched process was added. The [complete raw report](persistent-runtimes/resources/2026-11-04-host-allowance-native-complete.json)
and [source/bundle provenance](persistent-runtimes/resources/2026-11-04-host-allowance-native-complete-provenance.json)
preserve the calibrated counters and exact source snapshot separately from the
two partial runs.

| Runtimes | Summed owner RSS, MiB | Owner RSS median / max, MiB | Owner self CPU, % of one core | Owner reaped-child CPU, % of one core | Owner interrupt wakeups/s | Median / maximum re-adoption, ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 77.81 | 77.81 / 77.81 | 0.030 | 0.070 | 2.03 | 22.12 / 23.36 |
| 10 | 779.69 | 77.88 / 79.25 | 0.683 | 0.838 | 22.76 | 90.36 / 103.06 |
| 50 | 2,669.14 | 49.34 / 68.89 | 3.700 | 4.908 | 109.75 | 416.26 / 438.74 |

Every owner had **26 numeric descriptors** and every shell four: 1,300 owner
descriptors and 200 shell descriptors at fifty, distributed across independent
processes. Shell RSS totals were 2.25, 22.50 and 60.16 MiB. Shell self CPU and
wakeups remained zero during all three windows. Controller-plus-harness self CPU
was 0.026%, 0.023% and 0.043% of one core, with interrupt wakeups of 1.27/s,
1.30/s and 1.30/s. At fifty, reaped owner children also recorded 0.83 interrupt
wakeups/s. All sampled groups recorded zero package-idle wakeups. Reaped-child
CPU still excludes live children, and the controller measurement still includes
the test harness; this is not a complete production process-tree or energy budget.

Calibration passed at timebase 125/3: converted self CPU was 50.005 ms versus
50.003 ms and 50.002 ms from the independent clocks; reaped-child CPU was
50.199 ms versus 50.198 ms. Five controlled sleeps again recorded five interrupt
and zero package-idle wakeups. The unchanged admission guard saw 56% headroom
before each scale, and the last fifty-owner observation recorded 50% of 24 GiB.

All three scales passed the existing RSS, descriptor and adoption ceilings;
the report records no fixture regressions. The lower median RSS at fifty is not
a measured saving from the host allowance: shared pages, compression/reclamation,
garbage collection and workstation activity prevent that attribution. The run
establishes a complete calibrated macOS plain-shell baseline, not a statistical
tail bound. CPU/wakeup ceilings had not yet been set when this run was recorded.

The harness verified every tracked owner exited and every known shell was absent
before writing the report. An independent post-run check found **all 101 sampled
PIDs absent**: fifty owners, fifty shells and the controller/test process. The
temporary bundle was removed. No installed service, real provider home or
production daemon was modified.

## Enforced calibrated macOS fixture ceilings

The opt-in harness now enforces the following **plain-shell investigation
thresholds** after fifteen seconds of settling and a thirty-second calibrated
sample. CPU columns are separate sums across owners, expressed as percentages
of **one core**, not percentages of the whole machine. These thresholds supplement
the existing RSS, descriptor and adoption ceilings; they are not product capacity
guarantees or limits on real provider workloads.

| Owners | Owner self CPU ceiling | Owner reaped-child CPU ceiling | Owner interrupt-wakeup ceiling, per second |
| --- | ---: | ---: | ---: |
| 1 | 1% | 1% | 6 |
| 10 | 3% | 3% | 60 |
| 50 | 15% | 15% | 350 |

All four calibrated reports above contributed to the choice, including completed
rows from both partial runs. They contain four observations each at one and ten
owners, and one at fifty. Their maxima were:

| Owners | Observed maximum self CPU | Observed maximum reaped-child CPU | Observed maximum owner interrupt wakeups/s |
| --- | ---: | ---: | ---: |
| 1 | 0.267782% | 0.135464% | 2.865988 |
| 10 | 1.460237% | 1.231446% | 25.397053 |
| 50 | 3.699740% | 4.907679% | 109.753206 |

For one and ten owners, each maximum receives a twofold margin. CPU ceilings
round upwards to whole percentage points; wakeup ceilings round upwards to one
and ten wakeups/s respectively. Fifty owners receives a threefold margin because
only one calibrated observation exists, rounded upwards to five percentage points
and fifty wakeups/s. These are engineering tripwires for material idle regressions,
not statistical confidence or tail bounds. Repeated controlled-runner observations
can refine them without changing the standard runtime feature's availability.

Each comparison uses its **native upper timing-bracket rate independently**.
Lower owner CPU cannot offset excessive reaped-child CPU, and neither can offset
excessive interrupt wakeups. Missing calibration, missing native rates, negative
or non-finite values, and reversed self-CPU brackets fail the macOS gate explicitly.
Coarse `ps` CPU readings and missing values are never substituted as zero.
Linux continues to evaluate the existing RSS/descriptor/adoption checks and
reports native measurements unavailable; these macOS CPU/wakeup thresholds are
not applied to Linux. Package-idle and reaped-child wakeups remain recorded but
do not receive inferred thresholds from this mostly zero-valued corpus.

The focused **52-test** suite replays all nine recorded calibrated rows, verifies
equality and just-over-boundary behaviour for every metric/scale, checks independent
failures, and rejects missing/malformed macOS evidence. Every recorded row passes.
The raw artifacts retain the limits active when they were measured; this replay
does not claim that the new CPU/wakeup checks ran during those historical tests.
No additional native measurement was performed to select or test these thresholds.

## Remaining resource gates

Native macOS interrupt/package-idle wakeups are now measured at one, ten and fifty
plain-shell runtimes, with concrete fixture CPU/wakeup regression checks.
Repeatability on controlled runners and equivalent Linux measurements remain
open. Provider CLI/sidecar
overhead, isolated controller/daemon RSS and CPU,
service-manager overhead, active output and slow
consumers, host-wide retained storage and native-provider workloads remain open.
This report supplies a repeatable baseline and enforced fixture investigation
limits; it does not claim all resource acceptance gates are met. Its
RSS limits are distinct from the implemented transport/viewer buffer capacities.
The shared host allowance bounds charged managed capacity; it does not bound
total RSS, provider memory or operating-system caches, or replace workload
measurements.
