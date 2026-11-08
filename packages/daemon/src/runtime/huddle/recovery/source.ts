import { join } from 'node:path';
import { canonicalHuddleJson, runtimeRetiredSchema } from '@puddle/shared';
import { atomicPrivateJson } from '@puddle/shared/node';
import type { RuntimeBinding } from '../../../db/stores/runtimes.js';
import { acquireHostClaim } from '../../../security/claims.js';
import { acquireRuntimeRetirementClaims } from '../../ownership/retirement-claims.js';
import { readRuntimeJson } from '../../ownership/storage.js';
import { retireRuntimeMemoryGrant } from '../../resources/host/retirement.js';
import { huddleBindingLaunch } from '../ownership/binding.js';
import { retainedHuddleDirectory } from '../state/readers/database.js';
import { readRecordedHuddleActivation } from '../state/readers/activation.js';
import { readRetainedHuddleRevision } from '../state/revisions.js';

/** A different verified boot fences every old descendant, including detached script children. */
export function acquireHuddleRecoverySource(
  home: string,
  binding: RuntimeBinding,
  boot: string | null,
) {
  const claims = acquireRuntimeRetirementClaims(home, binding.runtime_id);
  const extra: Array<{ release(): void }> = [];
  try {
    extra.push(acquireHostClaim(home, `huddle-state:${binding.runtime_id}`));
    extra.push(acquireHostClaim(home, `huddle-revisions:${binding.runtime_id}`));
    const source = huddleBindingLaunch(home, binding);
    if (!boot || !source.boot_id || boot === source.boot_id || binding.state === 'exited')
      throw new Error('Recovery requires an unresolved owner from a verified earlier host boot');
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
