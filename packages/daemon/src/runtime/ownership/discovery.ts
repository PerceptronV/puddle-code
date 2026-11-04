import { join } from 'node:path';
import {
  runtimeLaunchSchema,
  runtimeRetiredSchema,
  runtimeStateSchema,
  type RuntimeControllerRecord,
  type RuntimeIdentity,
  type RuntimeJournalRecord,
  type RuntimeState,
} from '@puddle/shared';
import { atomicPrivateJson } from '@puddle/shared/node';
import { acquireRuntimeClaim, RuntimeClaimBusy } from './claims.js';
import { RuntimeClient } from '../transport/client.js';
import { readRuntimeJson, runtimeDirectory } from './storage.js';
import { readRuntimeJournal } from '../state/journal.js';

function checkIdentity(actual: RuntimeIdentity, expected: RuntimeIdentity): void {
  for (const key of Object.keys(expected) as Array<keyof RuntimeIdentity>) {
    if (actual[key] !== expected[key]) throw new Error('Runtime ownership identity changed');
  }
}

/** Failed connection/negotiation means unavailable, never proof that execution ended. */
export async function connectRuntimeOwner(
  home: string,
  identity: RuntimeIdentity,
  controller: RuntimeControllerRecord,
): Promise<RuntimeClient> {
  const directory = runtimeDirectory(home, identity.runtime_id);
  const launch = runtimeLaunchSchema.parse(readRuntimeJson(join(directory, 'launch.json')));
  checkIdentity(launch.identity, identity);
  const client = await RuntimeClient.open(home, launch, controller);
  try {
    if (!client.state) throw new Error('Runtime did not report its state');
    checkIdentity(client.state.identity, identity);
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}

/**
 * Retire only while holding the same OS claim required before any owner starts.
 * The marker prevents an already-dispatched, delayed launcher from starting after
 * this lock is released. Commit confirmed absence/exit to SQLite inside apply;
 * a failed commit leaves the marker, so retrying cannot replay the old launch.
 */
export function retireMissingRuntime(
  home: string,
  identity: RuntimeIdentity,
  apply: (finalState: RuntimeState | null, journal: RuntimeJournalRecord | null) => void,
): 'retired' | 'owned' {
  const directory = runtimeDirectory(home, identity.runtime_id);
  let claim: ReturnType<typeof acquireRuntimeClaim>;
  let launchClaim: ReturnType<typeof acquireRuntimeClaim> | undefined;
  try {
    launchClaim = acquireRuntimeClaim(home, `runtime-launch:${identity.runtime_id}`);
    claim = acquireRuntimeClaim(home, `runtime:${identity.runtime_id}`);
  } catch (error) {
    launchClaim?.release();
    if (error instanceof RuntimeClaimBusy) return 'owned';
    throw error;
  }
  try {
    const launch = runtimeLaunchSchema.parse(readRuntimeJson(join(directory, 'launch.json')));
    checkIdentity(launch.identity, identity);
    let state: RuntimeState | null = null;
    try {
      state = runtimeStateSchema.parse(readRuntimeJson(join(directory, 'state.json')));
      checkIdentity(state.identity, identity);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let journal: RuntimeJournalRecord | null = null;
    try {
      journal = readRuntimeJournal(directory, identity);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const file = join(directory, 'retired.json');
    try {
      checkIdentity(runtimeRetiredSchema.parse(readRuntimeJson(file)).identity, identity);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      atomicPrivateJson(file, { format: 1, identity });
    }
    apply(state, journal);
    return 'retired';
  } finally {
    claim.release();
    launchClaim.release();
  }
}
