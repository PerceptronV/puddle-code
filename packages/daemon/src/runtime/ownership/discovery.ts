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
import { HostClaimBusy } from '../../security/claims.js';
import { acquireRuntimeRetirementClaims } from './retirement-claims.js';
import { retireRuntimeMemoryGrant } from '../resources/host/retirement.js';
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
  let claims: ReturnType<typeof acquireRuntimeRetirementClaims>;
  try {
    claims = acquireRuntimeRetirementClaims(home, identity.runtime_id);
  } catch (error) {
    if (error instanceof HostClaimBusy) return 'owned';
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
      atomicPrivateJson(file, { format: 1, identity }, { syncDirectory: true });
    }
    retireRuntimeMemoryGrant(home, identity, claims);
    apply(state, journal);
    return 'retired';
  } finally {
    claims.release();
  }
}
