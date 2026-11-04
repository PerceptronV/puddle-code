# Persistent runtime resource baseline — 4 November 2026

Fifty isolated idle shell runtimes used **3,355 MiB of summed owner RSS** in the
settled measurement. Their median controller re-adoption took **402 ms**. The
estimated owner CPU was **3.1% of one core**, but the process-time display precision
allows roughly five percentage points of aggregate uncertainty at this count and
sample length. This establishes a repeatable fixture baseline, not completion of
the production resource acceptance gates.

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

## Remaining resource gates

Wakeups were **not measured**. CPU time and the known polling interval do not
substitute for wakeup or energy measurements. Provider CLI/sidecar overhead,
controller/daemon RSS and CPU, service-manager overhead, active output and slow
consumers, host-wide buffering, native-provider workloads, and equivalent Linux
measurements remain open. This report supplies a repeatable baseline and proposed
monitoring limits; it does not claim all resource acceptance gates are met. Its
RSS limits also do not enforce production host-wide buffer or memory allocation
limits; those require separate implementation and workload evidence.
