import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clientHome } from './paths.js';

/**
 * The cockpit registry: one JSON file per target under ~/.puddle/cockpits/,
 * written by the running cockpit process (background or foreground alike) so
 * `puddle list` and `puddle kill` can find it after the launching terminal is
 * long gone. A record is a claim, not a guarantee — liveness is verified
 * against the process AND the UI server's nonce, never assumed (the lesson
 * of the daemon-port collision: identity, not reachability).
 */

export interface CockpitRecord {
  /** 'local', or the user@host argument the cockpit fronts. */
  target: string;
  pid: number;
  status: 'starting' | 'ready' | 'error';
  startedAt: string;
  cliVersion: string;
  /** Set once ready. */
  origin?: string;
  /** Contains the daemon token fragment — the record file is mode 0600. */
  browserUrl?: string;
  /** Echoed by the UI server as X-Puddle-Cockpit; proves origin is this cockpit. */
  nonce?: string;
  logFile?: string;
  /** Set on status 'error' so the launcher can relay the failure. */
  message?: string;
  hint?: string;
}

/**
 * 'dead' (pid gone) is the only state safe to prune. 'unverified' — pid
 * alive but the origin did not echo the nonce (a recycled pid, a stranger on
 * the port, or just a cockpit too busy to answer in time) — must never be
 * auto-deleted: the record is the only handle to a possibly-live process.
 */
export type CockpitLiveness = 'running' | 'starting' | 'unverified' | 'dead';

function cockpitsDir(env?: Record<string, string | undefined>): string {
  return join(clientHome(env), 'cockpits');
}

/** Filesystem-safe name for a target ('local' or user@host). */
function slug(target: string): string {
  return target.replace(/[^A-Za-z0-9@._-]/g, '_');
}

export function cockpitRecordPath(target: string): string {
  return join(cockpitsDir(), `${slug(target)}.json`);
}

/** Where a cockpit's own output lands when it runs detached. */
export function cockpitLogPath(target: string): string {
  return join(clientHome(), 'logs', `cockpit-${slug(target)}.log`);
}

export function writeCockpitRecord(record: CockpitRecord): void {
  mkdirSync(cockpitsDir(), { recursive: true, mode: 0o700 });
  writeFileSync(cockpitRecordPath(record.target), JSON.stringify(record, null, 2) + '\n', {
    mode: 0o600,
  });
}

export function readCockpitRecord(target: string): CockpitRecord | null {
  try {
    return JSON.parse(readFileSync(cockpitRecordPath(target), 'utf8')) as CockpitRecord;
  } catch {
    return null;
  }
}

export function removeCockpitRecord(target: string): void {
  rmSync(cockpitRecordPath(target), { force: true });
}

export function listCockpitRecords(): CockpitRecord[] {
  let names: string[];
  try {
    names = readdirSync(cockpitsDir());
  } catch {
    return [];
  }
  const records: CockpitRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      records.push(JSON.parse(readFileSync(join(cockpitsDir(), name), 'utf8')) as CockpitRecord);
    } catch {
      // A half-written or corrupt record reads as absent; verification would
      // have discarded it anyway.
    }
  }
  return records.sort((a, b) => a.target.localeCompare(b.target));
}

/** Signal-0 probe; embeddable (no TTY, no console) so it may live here. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is the record's cockpit actually there? 'running' requires the process to
 * be alive AND the recorded origin to echo the recorded nonce — identity,
 * never reachability alone.
 */
export async function checkCockpit(record: CockpitRecord): Promise<CockpitLiveness> {
  if (!isPidAlive(record.pid)) return 'dead';
  if (record.status === 'starting') return 'starting';
  if (record.status !== 'ready' || record.origin === undefined || record.nonce === undefined) {
    return 'unverified';
  }
  try {
    const res = await fetch(`${record.origin}/`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(1500),
    });
    return res.headers.get('x-puddle-cockpit') === record.nonce ? 'running' : 'unverified';
  } catch {
    return 'unverified';
  }
}
