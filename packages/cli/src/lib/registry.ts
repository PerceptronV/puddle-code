import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { atomicPrivateJson, privateDirectory } from '@puddle/shared/node';
import { join } from 'node:path';
import { clientHome } from './paths.js';

/**
 * The frontend registry: one JSON file per target in the shared launcher registry,
 * written by the running frontend process (background or foreground alike) so
 * `puddle list` and `puddle kill` can find it after the launching terminal is
 * long gone. A record is a claim, not a guarantee — liveness is verified
 * against the process AND the UI server's nonce, never assumed (the lesson
 * of the daemon-port collision: identity, not reachability).
 */

export interface FrontendRecord {
  /** 'local', or the user@host argument the frontend fronts. */
  target: string;
  pid: number;
  status: 'starting' | 'ready' | 'error';
  startedAt: string;
  cliVersion: string;
  /** Set once ready. */
  origin?: string;
  /** Protected launcher IPC address; contains no credentials. */
  launcherPath?: string;
  /** Echoed by the UI server as X-Puddle-Frontend; proves origin is this frontend. */
  nonce?: string;
  /** `frontend` when the remote daemon is held by this process's SSH channel. */
  daemonLifetime?: 'persistent' | 'frontend';
  logFile?: string;
  /** Set on status 'error' so the launcher can relay the failure. */
  message?: string;
  hint?: string;
}

/**
 * 'dead' (pid gone) is the only state safe to prune. 'unverified' — pid
 * alive but the origin did not echo the nonce (a recycled pid, a stranger on
 * the port, or just a frontend too busy to answer in time) — must never be
 * auto-deleted: the record is the only handle to a possibly-live process.
 */
export type FrontendLiveness = 'running' | 'starting' | 'unverified' | 'dead';

function frontendsDir(env?: Record<string, string | undefined>): string {
  // Keep the deployed namespace so older live launchers and newer clients discover
  // the same process claims during an upgrade; splitting it could launch duplicates.
  return join(clientHome(env), 'cockpits');
}

/** Filesystem-safe name for a target ('local' or user@host). */
function slug(target: string): string {
  return target.replace(/[^A-Za-z0-9@._-]/g, '_');
}

export function frontendRecordPath(target: string): string {
  return join(frontendsDir(), `${slug(target)}.json`);
}

/** Where a frontend's own output lands when it runs detached. */
export function frontendLogPath(target: string): string {
  return join(clientHome(), 'logs', `frontend-${slug(target)}.log`);
}

export function writeFrontendRecord(record: FrontendRecord): void {
  privateDirectory(frontendsDir());
  atomicPrivateJson(frontendRecordPath(record.target), sanitise(record));
}

export function readFrontendRecord(target: string): FrontendRecord | null {
  try {
    const record = JSON.parse(readFileSync(frontendRecordPath(target), 'utf8')) as FrontendRecord;
    if ('browserUrl' in record) writeFrontendRecord(record);
    return sanitise(record);
  } catch {
    return null;
  }
}

export function removeFrontendRecord(target: string): void {
  rmSync(frontendRecordPath(target), { force: true });
}

export function listFrontendRecords(): FrontendRecord[] {
  let names: string[];
  try {
    names = readdirSync(frontendsDir());
  } catch {
    return [];
  }
  const records: FrontendRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const record = JSON.parse(readFileSync(join(frontendsDir(), name), 'utf8')) as FrontendRecord;
      if ('browserUrl' in record) writeFrontendRecord(record);
      records.push(sanitise(record));
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
 * Is the record's frontend actually there? 'running' requires the process to
 * be alive AND the recorded origin to echo the recorded nonce — identity,
 * never reachability alone.
 */
export async function checkFrontend(record: FrontendRecord): Promise<FrontendLiveness> {
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
    // Older running frontends expose only the legacy identity header.
    const nonce = res.headers.get('x-puddle-frontend') ?? res.headers.get('x-puddle-cockpit');
    return nonce === record.nonce ? 'running' : 'unverified';
  } catch {
    return 'unverified';
  }
}

function sanitise(record: FrontendRecord): FrontendRecord {
  const {
    target,
    pid,
    status,
    startedAt,
    cliVersion,
    origin,
    nonce,
    launcherPath,
    daemonLifetime: storedLifetime,
    logFile,
    message,
    hint,
  } = record;
  // Records written by an older live launcher retain its original lifetime name.
  const daemonLifetime =
    (storedLifetime as string | undefined) === 'cockpit' ? 'frontend' : storedLifetime;
  return {
    target,
    pid,
    status,
    startedAt,
    cliVersion,
    origin,
    nonce,
    launcherPath,
    daemonLifetime,
    logFile,
    message,
    hint,
  };
}
