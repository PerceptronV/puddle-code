import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { cpus, release } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { RUNTIME_PROTOCOL_VERSION } from '@puddle/shared';
import { resourceBaselineLimits, resourceBaselineRegressions } from './limits.js';
import { nativeDeltas, nativeResourceProbe } from './native/probe.js';
import { atomicPrivateJson } from '@puddle/shared/node';
import { RuntimeConnections } from '../../../src/runtime/transport/connections.js';
import { RuntimeReconciler } from '../../../src/runtime/controller/reconcile.js';
import {
  acquireRuntimeControllerWhenAvailable,
  runtimeDirectory,
} from '../../../src/runtime/ownership/storage.js';
import { runtimeDatabase } from '../../helpers/runtime-database.js';
import {
  launchOwner,
  retainRuntimeHome,
  terminal,
  waitForOwner,
} from '../../helpers/runtime-fixture.js';
import {
  descriptorCounts,
  median,
  memoryHeadroom,
  measurementsWithExitedChildren,
  processMeasurements,
  sum,
} from './metrics.js';

const concurrency = 4;
const sampleMs = 30_000;
const warmupMs = 15_000;

it.runIf(process.env.PUDDLE_TEST_RUNTIME_RESOURCES === '1')(
  'measures isolated idle owners and authenticated controller re-adoption at 1, 10 and 50 runtimes',
  async () => {
    const f = runtimeDatabase();
    const owners: Array<{
      id: string;
      owner: ReturnType<typeof launchOwner>;
      shell: number;
      generation: string;
    }> = [];
    let connections: RuntimeConnections | undefined;
    let reconciler: RuntimeReconciler | undefined;
    let native: Awaited<ReturnType<typeof nativeResourceProbe>> | undefined;
    const report = {
      observed_at: new Date().toISOString(),
      environment: {
        platform: process.platform,
        release: release(),
        architecture: process.arch,
        node: process.version,
        logical_cpus: cpus().length,
        cpu_model: cpus()[0]?.model ?? 'unavailable',
      },
      method: {
        fixture_regression_ceilings: resourceBaselineLimits,
        sample_ms: sampleMs,
        warmup_ms: warmupMs,
        launch_concurrency: concurrency,
        adoption_samples: 3,
        provider: 'plain isolated /bin/sh; no native provider, sidecar or service manager',
        controller:
          'production RuntimeConnections and RuntimeReconciler in the test process; excludes daemon startup',
        cpu: 'cumulative ps CPU-time delta; percentage of one CPU core',
        cpu_precision:
          'Reported display-resolution margin allows one displayed CPU-time tick per owner; it is not a confidence interval and excludes asynchronous snapshot skew',
        reaped_child_cpu:
          'ps -S adds exited children, including terminal-monitor ps probes; excludes live children at sample boundaries and all controller/daemon CPU',
        rss: 'resident size summed across processes; shared pages may be counted repeatedly',
        descriptors:
          'numeric open descriptors; excludes cwd, executable and mapped-library pseudoentries',
        native:
          'macOS installed-SDK proc_pid_rusage, calibrated against CPU clock/getrusage; exact PID start identities and per-read elapsed bounds; raw decimal counters retained',
        native_controller:
          'test process including Vitest, controller and measurement orchestration; self only, excludes reaped measurement tools; not isolated daemon overhead',
        native_children:
          'owner reaped-child counters exclude live children; shell self counters reported separately; these do not establish a complete process-tree total',
        native_wakeups:
          'interrupt and package-idle wakeup counters only; not total scheduler wakeups or energy consumption',
        native_regression_scope:
          'macOS requires calibrated native owner self/reaped-child CPU and owner interrupt-wakeup upper rates; Linux/native-unavailable results do not establish those ceilings',
      },
      native_calibration: null as Record<string, unknown> | null,
      native_unavailable: null as string | null,
      completed: false,
      failure: null as string | null,
      results: [] as Array<Record<string, unknown>>,
    };
    const adopt = async () => {
      await reconciler?.close();
      await connections?.close();
      const start = performance.now();
      reconciler = new RuntimeReconciler(f);
      connections = new RuntimeConnections(
        f.home,
        f.runtimes,
        {
          connected: (id, client) => reconciler!.attach(id, client),
          missing: (id) => reconciler!.retire(id),
        },
        await acquireRuntimeControllerWhenAvailable(f.home),
      );
      await connections.connect();
      expect(connections.unavailableIds()).toEqual([]);
      for (const owner of owners) {
        const state = connections.get(owner.id)?.state;
        const main = terminal(state ?? null);
        expect(main).toMatchObject({ pid: owner.shell, generation: owner.generation });
        expect(reconciler.settled(owner.id)).toBe(true);
      }
      return performance.now() - start;
    };
    const admit = async (additional: number) => {
      const memory = await memoryHeadroom();
      // Limit peak experiment cost; these are admission reserves, not assertions
      // about an acceptable production runtime footprint.
      const reserve = Math.max(4 * 1024 ** 3, memory.total_bytes * 0.2);
      if (memory.available_bytes - additional * 100 * 1024 ** 2 < reserve)
        throw new Error(
          `Insufficient measured memory headroom for ${additional} additional fixture runtimes`,
        );
      return memory;
    };
    try {
      native = await nativeResourceProbe();
      report.native_unavailable = native.unavailable;
      if (native.probe) report.native_calibration = await native.probe.calibrate();
      await f.reconciler.close();
      f.controller.release();
      for (const target of [1, 10, 50]) {
        const memoryBefore = await admit(target - owners.length);
        const launchStart = performance.now();
        while (owners.length < target) {
          await admit(Math.min(concurrency, target - owners.length));
          const remaining = Math.min(concurrency, target - owners.length);
          const prepared = Array.from({ length: remaining }, (_, offset) => {
            if (owners.length === 0 && offset === 0)
              return { launch: f.launch, directory: f.directory };
            const session = f.sessions.create({ ...f.session, id: randomUUID() });
            const launch = {
              ...f.launch,
              secret: randomBytes(32).toString('hex'),
              identity: {
                ...f.launch.identity,
                runtime_id: randomUUID(),
                incarnation: randomUUID(),
                launch_id: randomUUID(),
                session_id: session.id,
              },
            };
            const directory = runtimeDirectory(f.home, launch.identity.runtime_id);
            atomicPrivateJson(join(directory, 'launch.json'), launch);
            f.runtimes.prepare({
              identity: launch.identity,
              build: 'runtime-test',
              protocol: RUNTIME_PROTOCOL_VERSION,
              releasePath: directory,
            });
            return { launch, directory };
          });
          const started: Array<{ item: (typeof owners)[number]; directory: string }> = [];
          for (const { launch, directory } of prepared) {
            let owner: ReturnType<typeof launchOwner>;
            const admissionDeadline = performance.now() + 5000;
            for (;;) {
              try {
                // launchOwner performs synchronous exact-grant admission BEFORE
                // spawn. SQLITE_BUSY here therefore cannot mean a dispatched
                // process; its next admission first observes any committed grant.
                owner = launchOwner(f.home, launch.identity.runtime_id);
                break;
              } catch (error) {
                if (
                  (error as { code?: string }).code !== 'SQLITE_BUSY' ||
                  performance.now() >= admissionDeadline
                )
                  throw error;
                await delay(25);
              }
            }
            // Track immediately, including a process whose readiness later fails.
            const item = { id: launch.identity.runtime_id, owner, shell: 0, generation: '' };
            owners.push(item);
            started.push({ item, directory });
          }
          // Readiness is observation-only: never retry a returned process.
          await Promise.all(
            started.map(async ({ item, directory }) => {
              await waitForOwner(item.owner, directory);
            }),
          );
        }
        // Initial attachment establishes terminal identities before timed replacement.
        await reconciler?.close();
        await connections?.close();
        reconciler = new RuntimeReconciler(f);
        connections = new RuntimeConnections(
          f.home,
          f.runtimes,
          {
            connected: (id, client) => reconciler!.attach(id, client),
            missing: (id) => reconciler!.retire(id),
          },
          await acquireRuntimeControllerWhenAvailable(f.home),
        );
        await connections.connect();
        expect(connections.unavailableIds()).toEqual([]);
        for (const owner of owners) {
          const main = terminal(connections.get(owner.id)?.state ?? null);
          if (owner.shell)
            expect(main).toMatchObject({ pid: owner.shell, generation: owner.generation });
          owner.shell = main.pid!;
          owner.generation = main.generation;
        }
        const launchMs = performance.now() - launchStart;
        await delay(warmupMs);
        const ownerPids = owners.map(({ owner }) => owner.child.pid!);
        const shellPids = owners.map(({ shell }) => shell);
        const before = await processMeasurements([...ownerPids, ...shellPids]);
        const beforeWithChildren = await measurementsWithExitedChildren(ownerPids);
        const nativeBefore = await native.probe?.sample([...ownerPids, ...shellPids, process.pid]);
        const sampleStart = performance.now();
        await delay(sampleMs);
        const nativeAfter = await native.probe?.sample([...ownerPids, ...shellPids, process.pid]);
        const after = await processMeasurements([...ownerPids, ...shellPids]);
        const afterWithChildren = await measurementsWithExitedChildren(ownerPids);
        const elapsed = performance.now() - sampleStart;
        const nativeRows =
          nativeBefore && nativeAfter ? nativeDeltas(nativeBefore, nativeAfter) : null;
        const nativeGroup = (pids: number[], includeChildren: boolean) => {
          if (!nativeRows) return null;
          const rows = nativeRows.filter((row) => pids.includes(row.pid));
          return {
            self_cpu_ms: sum(rows.map((row) => row.self_cpu_ms)),
            // Sum each process's rate over its own bracketed interval, rather
            // than treating sequential libproc reads as simultaneous.
            self_cpu_one_core_percent_upper: sum(
              rows.map((row) => (100 * row.self_cpu_ms) / row.elapsed_min_ms),
            ),
            self_cpu_one_core_percent_lower: sum(
              rows.map((row) => (100 * row.self_cpu_ms) / row.elapsed_max_ms),
            ),
            self_interrupt_wakeups_per_second_upper: sum(
              rows.map((row) => (1000 * row.self_interrupt_wakeups) / row.elapsed_min_ms),
            ),
            self_package_idle_wakeups_per_second_upper: sum(
              rows.map((row) => (1000 * row.self_package_idle_wakeups) / row.elapsed_min_ms),
            ),
            reaped_children_cpu_ms: includeChildren
              ? sum(rows.map((row) => row.reaped_children_cpu_ms))
              : null,
            reaped_children_cpu_one_core_percent_upper: includeChildren
              ? sum(rows.map((row) => (100 * row.reaped_children_cpu_ms) / row.elapsed_min_ms))
              : null,
            reaped_children_interrupt_wakeups_per_second_upper: includeChildren
              ? sum(
                  rows.map(
                    (row) => (1000 * row.reaped_children_interrupt_wakeups) / row.elapsed_min_ms,
                  ),
                )
              : null,
            reaped_children_package_idle_wakeups_per_second_upper: includeChildren
              ? sum(
                  rows.map(
                    (row) => (1000 * row.reaped_children_package_idle_wakeups) / row.elapsed_min_ms,
                  ),
                )
              : null,
          };
        };
        const selected = (pids: number[]) => after.filter((row) => pids.includes(row.pid));
        const ownerRows = selected(ownerPids);
        const shellRows = selected(shellPids);
        const cpu = (pids: number[]) =>
          sum(
            selected(pids).map(
              (row) => row.cpu_ms - before.find((old) => old.pid === row.pid)!.cpu_ms,
            ),
          );
        const cpuWithChildren =
          beforeWithChildren.rows && afterWithChildren.rows
            ? sum(
                afterWithChildren.rows.map(
                  (row) =>
                    row.cpu_ms -
                    beforeWithChildren.rows!.find((old) => old.pid === row.pid)!.cpu_ms,
                ),
              )
            : null;
        const ownerDescriptors = await descriptorCounts(ownerPids);
        const shellDescriptors = await descriptorCounts(shellPids);
        const adoption: number[] = [];
        for (let pass = 0; pass < 3; pass++) adoption.push(await adopt());
        const result = {
          count: target,
          memory_before: memoryBefore,
          memory_after: await memoryHeadroom(),
          launch_and_initial_attach_ms: launchMs,
          sample_elapsed_ms: elapsed,
          owner_rss_mib: {
            total: sum(ownerRows.map((row) => row.rss_kib)) / 1024,
            median: median(ownerRows.map((row) => row.rss_kib)) / 1024,
            max: Math.max(...ownerRows.map((row) => row.rss_kib)) / 1024,
          },
          shell_rss_total_mib: sum(shellRows.map((row) => row.rss_kib)) / 1024,
          owner_cpu_ms: cpu(ownerPids),
          owner_cpu_one_core_percent: (100 * cpu(ownerPids)) / elapsed,
          owner_cpu_display_resolution_margin_percent:
            (100 * sum(ownerRows.map((row) => row.cpu_resolution_ms))) / elapsed,
          owner_and_reaped_children_cpu_ms: cpuWithChildren,
          owner_and_reaped_children_cpu_one_core_percent:
            cpuWithChildren === null ? null : (100 * cpuWithChildren) / elapsed,
          reaped_child_cpu_unavailable:
            beforeWithChildren.unavailable ?? afterWithChildren.unavailable,
          shell_cpu_ms: cpu(shellPids),
          native: nativeRows
            ? {
                owners: nativeGroup(ownerPids, true),
                shells: nativeGroup(shellPids, false),
                controller_with_harness: nativeGroup([process.pid], false),
                deltas: nativeRows,
                before: nativeBefore,
                after: nativeAfter,
              }
            : null,
          owner_descriptors: ownerDescriptors,
          shell_descriptors: shellDescriptors,
          adoption_ms: { samples: adoption, median: median(adoption), max: Math.max(...adoption) },
        };
        const regressions = resourceBaselineRegressions(result, {
          platform: process.platform,
          nativeCalibrated: report.native_calibration !== null,
        });
        report.results.push({ ...result, regressions });
        expect(regressions).toEqual([]);
      }
      report.completed = true;
    } catch (error) {
      report.failure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      await reconciler?.close();
      await connections?.close();
      try {
        for (let offset = 0; offset < owners.length; offset += concurrency) {
          await Promise.all(
            owners.slice(offset, offset + concurrency).map(async ({ owner, shell }) => {
              if (owner.child.exitCode === null && owner.child.signalCode === null) {
                const ended = once(owner.child, 'exit');
                owner.child.kill('SIGTERM');
                const timeout = new AbortController();
                try {
                  await Promise.race([
                    ended,
                    delay(10_000, undefined, { signal: timeout.signal }).then(() => {
                      throw new Error('Runtime fixture exit was not confirmed');
                    }),
                  ]);
                } finally {
                  timeout.abort();
                }
              }
              if (shell)
                expect(() => process.kill(shell, 0)).toThrowError(
                  expect.objectContaining({ code: 'ESRCH' }),
                );
            }),
          );
        }
      } catch (error) {
        retainRuntimeHome(f.home);
        // eslint-disable-next-line no-unsafe-finally -- Preserve fixture data if owner cleanup cannot be verified.
        throw new Error(`Resource fixture cleanup failed; retained ${f.home}`, { cause: error });
      } finally {
        f.db.close();
        await native?.probe?.close();
      }
      // Preserve measured failure evidence after confirmed cleanup, including a
      // partial run stopped before another scale could increase memory pressure.
      const output = JSON.stringify(report, null, 2) + '\n';
      if (process.env.PUDDLE_TEST_RUNTIME_RESOURCE_REPORT)
        writeFileSync(process.env.PUDDLE_TEST_RUNTIME_RESOURCE_REPORT, output, { mode: 0o600 });
      else console.info(output);
    }
  },
  300_000,
);
