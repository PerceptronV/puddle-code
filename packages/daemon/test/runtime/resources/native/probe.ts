import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';

const counter = z
  .string()
  .regex(/^\d{1,20}$/)
  .refine((value) => BigInt(value) <= 0xffffffffffffffffn);
const timebase = z
  .object({ numer: z.number().int().positive(), denom: z.number().int().positive() })
  .strict();
const row = z
  .object({
    pid: z.number().int().positive(),
    start_ticks: counter,
    exit_ticks: counter,
    before_ticks: counter,
    after_ticks: counter,
    user_ticks: counter,
    system_ticks: counter,
    reaped_child_user_ticks: counter,
    reaped_child_system_ticks: counter,
    interrupt_wakeups: counter,
    package_idle_wakeups: counter,
    reaped_child_interrupt_wakeups: counter,
    reaped_child_package_idle_wakeups: counter,
  })
  .strict();
export const nativeSnapshotSchema = z
  .object({ timebase, rows: z.array(row).min(1).max(128) })
  .strict();
export type NativeSnapshot = z.infer<typeof nativeSnapshotSchema>;
const calibrationSchema = z
  .object({
    timebase,
    self_ticks: counter,
    self_ns: counter,
    clock_process_ns: counter,
    getrusage_self_ns: counter,
    reaped_child_ticks: counter,
    reaped_child_ns: counter,
    getrusage_children_ns: counter,
    interrupt_wakeups: counter,
    package_idle_wakeups: counter,
  })
  .strict();

const execute = (file: string, args: string[], cwd: string, timeout = 5000) =>
  promisify(execFile)(file, args, {
    cwd,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', HOME: cwd, TMPDIR: cwd },
    timeout,
    maxBuffer: 256 * 1024,
  });

export function machNanoseconds(ticks: bigint, scale: NativeSnapshot['timebase']): bigint {
  return (ticks * BigInt(scale.numer)) / BigInt(scale.denom);
}

/** Compare counters belonging to the same live PID incarnation; never substitute missing rows. */
export function nativeDeltas(before: NativeSnapshot, after: NativeSnapshot) {
  if (
    JSON.stringify(before.timebase) !== JSON.stringify(after.timebase) ||
    before.rows.length !== after.rows.length
  )
    throw new Error('Native measurement cohort or timebase changed');
  return after.rows.map((current) => {
    const previous = before.rows.find(({ pid }) => pid === current.pid);
    if (
      !previous ||
      current.start_ticks === '0' ||
      previous.start_ticks !== current.start_ticks ||
      current.exit_ticks !== '0' ||
      previous.exit_ticks !== '0'
    )
      throw new Error('Measured process ended or changed identity');
    const delta = (name: Exclude<keyof typeof current, 'pid'>) => {
      const value = BigInt(current[name]) - BigInt(previous[name]);
      if (value < 0n) throw new Error('Native process counter decreased');
      return value;
    };
    const start = BigInt(previous.after_ticks);
    const end = BigInt(current.before_ticks);
    if (end <= start || BigInt(previous.before_ticks) > start || BigInt(current.after_ticks) < end)
      throw new Error('Native measurement intervals overlap or are unordered');
    const milliseconds = (ticks: bigint) => Number(machNanoseconds(ticks, after.timebase)) / 1e6;
    return {
      pid: current.pid,
      self_cpu_ms: milliseconds(delta('user_ticks') + delta('system_ticks')),
      reaped_children_cpu_ms: milliseconds(
        delta('reaped_child_user_ticks') + delta('reaped_child_system_ticks'),
      ),
      self_interrupt_wakeups: Number(delta('interrupt_wakeups')),
      self_package_idle_wakeups: Number(delta('package_idle_wakeups')),
      reaped_children_interrupt_wakeups: Number(delta('reaped_child_interrupt_wakeups')),
      reaped_children_package_idle_wakeups: Number(delta('reaped_child_package_idle_wakeups')),
      elapsed_min_ms: milliseconds(end - start),
      elapsed_max_ms: milliseconds(BigInt(current.after_ticks) - BigInt(previous.before_ticks)),
    };
  });
}

/** Test-only compiler/probe: no downloaded code, task ports, sudo or production hooks. */
export async function nativeResourceProbe() {
  if (process.platform !== 'darwin')
    return {
      probe: null,
      unavailable:
        'Native CPU/wakeup probe is implemented only for macOS; coarse ps data is separate',
    };
  const directory = await mkdtemp(join(tmpdir(), 'puddle-resource-probe-'));
  await chmod(directory, 0o700);
  const executable = join(directory, 'probe');
  const close = () => rm(directory, { recursive: true, force: true });
  try {
    await execute(
      '/usr/bin/xcrun',
      [
        '--sdk',
        'macosx',
        'clang',
        '-std=c11',
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        fileURLToPath(new URL('./darwin.c', import.meta.url)),
        '-o',
        executable,
      ],
      directory,
      30_000,
    );
  } catch (error) {
    await close();
    return {
      probe: null,
      unavailable: `Native SDK compiler unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let calibrated = false;
  return {
    unavailable: null,
    probe: {
      close,
      async calibrate() {
        const result = calibrationSchema.parse(
          JSON.parse((await execute(executable, ['--calibrate'], directory)).stdout),
        );
        const check = (ticks: string, converted: string, reference: string) => {
          const nanos = machNanoseconds(BigInt(ticks), result.timebase);
          if (nanos !== BigInt(converted)) throw new Error('Native Mach-time conversion disagrees');
          const actual = Number(nanos);
          const expected = Number(reference);
          // Bracketed API calls add a small amount of work; precision is not assumed to be one tick.
          if (expected < 40_000_000 || Math.abs(actual - expected) > 2_000_000 + expected * 0.05)
            throw new Error(
              'Native CPU units did not calibrate against independent process accounting',
            );
        };
        check(result.self_ticks, result.self_ns, result.clock_process_ns);
        check(result.self_ticks, result.self_ns, result.getrusage_self_ns);
        check(result.reaped_child_ticks, result.reaped_child_ns, result.getrusage_children_ns);
        calibrated = true;
        return result;
      },
      async sample(pids: number[]): Promise<NativeSnapshot> {
        if (!calibrated) throw new Error('Calibrate native process counters before sampling');
        if (
          !pids.length ||
          pids.length > 128 ||
          new Set(pids).size !== pids.length ||
          pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff)
        )
          throw new Error('Invalid native fixture PID cohort');
        const result = nativeSnapshotSchema.parse(
          JSON.parse((await execute(executable, pids.map(String), directory)).stdout),
        );
        if (
          result.rows.length !== pids.length ||
          result.rows.some((row, index) => row.pid !== pids[index])
        )
          throw new Error('Native probe omitted or substituted a fixture PID');
        return result;
      },
    },
  };
}
