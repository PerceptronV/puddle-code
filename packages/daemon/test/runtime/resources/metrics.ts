import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { promisify } from 'node:util';

const execute = (file: string, args: string[]) =>
  promisify(execFile)(file, args, {
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' },
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
  });

export interface MemoryHeadroom {
  total_bytes: number;
  available_bytes: number;
  source: 'memory_pressure percentage' | 'MemAvailable';
}

/** A conservative admission guard, separate from measured runtime regression budgets. */
export async function memoryHeadroom(): Promise<MemoryHeadroom> {
  const total = totalmem();
  if (process.platform === 'darwin') {
    const result = await execute('/usr/bin/memory_pressure', ['-Q']);
    const match = /System-wide memory free percentage:\s*(\d+)%/.exec(result.stdout);
    if (!match) throw new Error('Cannot establish macOS memory headroom');
    return {
      total_bytes: total,
      available_bytes: (total * Number(match[1])) / 100,
      source: 'memory_pressure percentage',
    };
  }
  if (process.platform === 'linux') {
    const match = /^MemAvailable:\s+(\d+) kB$/m.exec(await readFile('/proc/meminfo', 'utf8'));
    if (!match) throw new Error('Cannot establish Linux memory headroom');
    return { total_bytes: total, available_bytes: Number(match[1]) * 1024, source: 'MemAvailable' };
  }
  throw new Error('Resource baseline requires a supported memory-headroom probe');
}

export interface ProcessMeasurement {
  pid: number;
  rss_kib: number;
  cpu_ms: number;
  cpu_resolution_ms: number;
}

function cpuMilliseconds(value: string): number {
  const [days, clock] = value.includes('-') ? (value.split('-') as [string, string]) : ['0', value];
  const parts = clock.split(':').map(Number);
  if (parts.length < 2 || parts.some((part) => !Number.isFinite(part)))
    throw new Error('Invalid process CPU time');
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return (Number(days) * 86_400 + seconds) * 1000;
}

export async function processMeasurements(
  pids: number[],
  includeExitedChildren = false,
): Promise<ProcessMeasurement[]> {
  const result = await execute('/bin/ps', [
    ...(includeExitedChildren ? ['-S'] : []),
    '-o',
    'pid=,rss=,time=',
    '-p',
    pids.join(','),
  ]);
  const rows = result.stdout
    .trim()
    .split('\n')
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+([\d:.-]+)\s*$/.exec(line);
      if (!match) throw new Error('Invalid resource process observation');
      return {
        pid: Number(match[1]),
        rss_kib: Number(match[2]),
        cpu_ms: cpuMilliseconds(match[3]!),
        cpu_resolution_ms: 1000 / 10 ** (/\.(\d+)$/.exec(match[3]!)?.[1]?.length ?? 0),
      };
    });
  if (rows.length !== pids.length || pids.some((pid) => !rows.some((row) => row.pid === pid)))
    throw new Error('A measured fixture process ended');
  return rows;
}

export async function measurementsWithExitedChildren(
  pids: number[],
): Promise<{ rows: ProcessMeasurement[] | null; unavailable: string | null }> {
  try {
    return { rows: await processMeasurements(pids, true), unavailable: null };
  } catch (error) {
    return { rows: null, unavailable: error instanceof Error ? error.message : String(error) };
  }
}

export async function descriptorCounts(
  pids: number[],
): Promise<{ counts: number[] | null; unavailable: string | null }> {
  try {
    if (process.platform === 'linux')
      return {
        counts: await Promise.all(
          pids.map(async (pid) => (await readdir(`/proc/${pid}/fd`)).length),
        ),
        unavailable: null,
      };
    if (process.platform !== 'darwin')
      return { counts: null, unavailable: 'No descriptor probe for this platform' };
    const result = await execute('/usr/sbin/lsof', ['-nP', '-a', '-p', pids.join(','), '-Fpf']);
    const counts = new Map<number, number>();
    let pid: number | undefined;
    for (const line of result.stdout.split('\n')) {
      if (/^p\d+$/.test(line)) {
        pid = Number(line.slice(1));
        counts.set(pid, 0);
      } else if (/^f\d+$/.test(line) && pid !== undefined) counts.set(pid, counts.get(pid)! + 1);
    }
    if (pids.some((id) => !counts.has(id)))
      throw new Error('Descriptor listing omitted a fixture process');
    return { counts: pids.map((id) => counts.get(id)!), unavailable: null };
  } catch (error) {
    return { counts: null, unavailable: error instanceof Error ? error.message : String(error) };
  }
}

export const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
export const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
