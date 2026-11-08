import { join } from 'node:path';
import {
  canonicalHuddleJson,
  runtimeRetiredSchema,
  type HuddleOwnerState,
  type RuntimeControllerRecord,
} from '@puddle/shared';
import { atomicPrivateJson } from '@puddle/shared/node';
import type { RuntimeBinding } from '../../../db/stores/runtimes.js';
import { HostClaimBusy } from '../../../security/claims.js';
import { acquireRuntimeRetirementClaims } from '../../ownership/retirement-claims.js';
import { readRuntimeJson, runtimeDirectory } from '../../ownership/storage.js';
import { retireRuntimeMemoryGrant } from '../../resources/host/retirement.js';
import { HuddleOwnerClient } from '../transport/client.js';
import { huddleBindingLaunch } from '../ownership/binding.js';
import { huddleRetirementState } from '../ownership/retirement.js';

export async function connectHuddleOwner(
  home: string,
  binding: RuntimeBinding,
  controller: RuntimeControllerRecord,
) {
  return HuddleOwnerClient.open(home, huddleBindingLaunch(home, binding), controller);
}

/** Absence requires all launch/owner claims; an IPC failure alone never releases a placement. */
export function retireMissingHuddle(
  home: string,
  binding: RuntimeBinding,
  apply: (state: HuddleOwnerState | null, clean: boolean) => void,
): boolean {
  let claims: ReturnType<typeof acquireRuntimeRetirementClaims>;
  try {
    claims = acquireRuntimeRetirementClaims(home, binding.runtime_id);
  } catch (error) {
    if (error instanceof HostClaimBusy) return false;
    throw error;
  }
  try {
    const launch = huddleBindingLaunch(home, binding);
    const directory = runtimeDirectory(home, binding.runtime_id);
    const read = (name: string) => {
      try {
        return readRuntimeJson(join(directory, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    };
    const { state, clean } = huddleRetirementState(
      binding,
      launch,
      read('huddle-owner.json'),
      read('consumed.json'),
    );
    const file = join(directory, 'retired.json');
    try {
      const retired = runtimeRetiredSchema.parse(readRuntimeJson(file));
      if (canonicalHuddleJson(retired.identity) !== canonicalHuddleJson(launch.identity))
        throw new Error('Huddle retirement identity changed');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      atomicPrivateJson(file, { format: 1, identity: launch.identity }, { syncDirectory: true });
    }
    // An absent parent does not prove its script descendants have ended.
    if (clean) retireRuntimeMemoryGrant(home, launch.identity, claims);
    apply(state, clean);
    return true;
  } finally {
    claims.release();
  }
}
