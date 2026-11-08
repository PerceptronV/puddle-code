import { join } from 'node:path';
import { requireHuddleDescendantsEnded } from './containment.js';
import { canonicalHuddleJson, runtimeRetiredSchema } from '@puddle/shared';
import { atomicPrivateJson } from '@puddle/shared/node';
import type { RuntimeBinding } from '../../../db/stores/runtimes.js';
import { acquireHostClaim } from '../../../security/claims.js';
import { acquireRuntimeRetirementClaims } from '../../ownership/retirement-claims.js';
import { readRuntimeJson } from '../../ownership/storage.js';
import { retireRuntimeMemoryGrant } from '../../resources/host/retirement.js';
import { huddleBindingLaunch } from '../ownership/binding.js';
import { retainedHuddleDirectory } from '../state/readers/database.js';
import {
  readRecordedHuddleActivation,
  readRecordedHuddleControl,
} from '../state/readers/activation.js';
import { readRetainedHuddleRevision } from '../state/revisions.js';

/** Fence old descendants through verified boot change or recorded kernel containment. */
export function acquireHuddleRecoverySource(
  home: string,
  binding: RuntimeBinding,
  boot: string | null,
  autoStartOnly = false,
  allowSameBoot = false,
) {
  const claims = acquireRuntimeRetirementClaims(home, binding.runtime_id);
  const extra: Array<{ release(): void }> = [];
  try {
    extra.push(acquireHostClaim(home, `huddle-state:${binding.runtime_id}`));
    extra.push(acquireHostClaim(home, `huddle-revisions:${binding.runtime_id}`));
    const source = huddleBindingLaunch(home, binding);
    if (!boot || !source.boot_id || binding.state === 'exited')
      throw new Error('Recovery requires an unresolved owner from a verified earlier host boot');
    const sameBoot = boot === source.boot_id;
    if (sameBoot && (!allowSameBoot || autoStartOnly))
      throw new Error('Recovery requires an unresolved owner from a verified earlier host boot');
    const containment = sameBoot ? requireHuddleDescendantsEnded(home, source) : undefined;
    if (autoStartOnly) {
      const control = readRecordedHuddleControl(home, source.scope);
      if (source.capabilities.autoStart !== 1 || control.state !== 'armed' || !control.autoStart)
        throw new Error('Huddle is no longer armed for automatic recovery');
    }
    const activation = readRecordedHuddleActivation(
      home,
      source.scope,
      source.identity.canonical_worktree_path,
    );
    const snapshot = readRetainedHuddleRevision(
      home,
      binding.runtime_id,
      source.scope.huddleId,
      activation.revision,
    );
    const file = join(retainedHuddleDirectory(home, binding.runtime_id), 'retired.json');
    try {
      const retired = runtimeRetiredSchema.parse(readRuntimeJson(file));
      if (canonicalHuddleJson(retired.identity) !== canonicalHuddleJson(source.identity))
        throw new Error('Huddle retirement identity changed');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      atomicPrivateJson(file, { format: 1, identity: source.identity }, { syncDirectory: true });
    }
    retireRuntimeMemoryGrant(home, source.identity, claims);
    return {
      source,
      containment,
      activation,
      snapshot,
      release() {
        for (const claim of extra.reverse()) claim.release();
        claims.release();
      },
    };
  } catch (error) {
    for (const claim of extra.reverse()) claim.release();
    claims.release();
    throw error;
  }
}
