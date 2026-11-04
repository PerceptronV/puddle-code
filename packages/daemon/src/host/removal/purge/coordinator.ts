import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  hostPurgeApplySchema,
  hostRemovalFinishSchema,
  type HostPurgeApply,
  type HostPurgeReview,
} from '@puddle/shared';
import { digest, readPrivateJson } from '@puddle/shared/node';
import {
  inspectHostRemoval,
  readHostBootIdentity,
  validateHostRemovalServices,
  hostPurgeFingerprint as purgeFingerprint,
  readHostPurgeRecord as readHostPurge,
} from '@puddle/shared/node/host-control';
import { HostRemovalGuard } from '../guard.js';
import type { RemovalInventoryOptions } from '../inventory.js';
import { verifyRemovalServiceUnregistered } from '../services.js';
import { removalRemoteAccess } from '../remote.js';
import { retirePurgeRuntimes } from './runtimes.js';
import { projectHostPurge, writeHostPurge } from './records.js';
import { reviewPurgeData } from './inventory.js';
import { reviewPurgeWorktrees } from './worktrees.js';
import { executePurgeData } from './execute.js';
import { requireNoRuntimeMemoryGrants } from '../../../runtime/resources/host/retirement.js';

interface Options extends RemovalInventoryOptions {
  authorised: () => boolean;
  bootIdentity?: () => Promise<string | null>;
}

async function withPurge<T>(
  home: string,
  release: string,
  options: Options,
  action: (guard: HostRemovalGuard, current: () => void, boot: string) => Promise<T>,
): Promise<T> {
  const guard = HostRemovalGuard.acquire(home);
  let controller: ReturnType<HostRemovalGuard['acquireController']> | undefined;
  try {
    const current = () => {
      guard.requireHeld();
      if (!options.authorised() || realpathSync(join(home, 'bin/current')) !== release)
        throw new Error('Purge authority or selected release changed');
    };
    current();
    controller = guard.acquireController();
    const boot = await (options.bootIdentity ?? readHostBootIdentity)();
    if (!boot) throw new Error('Kernel boot identity is unavailable; purge remains blocked');
    current();
    return await action(guard, current, boot);
  } finally {
    controller?.release();
    guard.release();
  }
}

function removal(home: string, id: string) {
  const purge = readHostPurge(home);
  let active = true;
  try {
    lstatSync(join(home, 'installation/removal/services.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    active = false;
  }
  const handedOff =
    !active &&
    purge?.id === id &&
    (purge.phase === 'deleting' || purge.phase === 'complete') &&
    purge.roots.every((root) => root.state === 'deleted');
  if (!handedOff) {
    const state = inspectHostRemoval(home);
    if (state.state !== 'removed' || state.id !== id)
      throw new Error('Complete this exact host removal before purge');
  }
  const record = validateHostRemovalServices(
    readPrivateJson(
      join(home, 'installation/removal', handedOff ? 'purged-services.json' : 'services.json'),
      512 * 1024,
    ),
  );
  const result = hostRemovalFinishSchema.parse(
    readPrivateJson(join(home, 'installation/removal/result.json'), 4096),
  );
  if (record.id !== id || result.id !== id || result.disposition !== 'stop')
    throw new Error('Purge requires separate explicit runtime stop consent');
  return { record, fingerprint: digest(JSON.stringify({ record, result })) };
}

async function verifyServices(
  guard: HostRemovalGuard,
  id: string,
  options: Options,
  previousBoot: boolean,
) {
  const evidence = removal(guard.home, id);
  for (const { review } of evidence.record.services)
    await verifyRemovalServiceUnregistered(
      guard,
      previousBoot ? { ...review, process: null } : review,
      options.authorised,
      options.run,
    );
  return evidence;
}

/** Explicit purge consent precedes this call. No user data is deleted during preparation. */
export async function prepareHostPurge(
  home: string,
  release: string,
  id: string,
  options: Options,
): Promise<HostPurgeReview> {
  return withPurge(home, release, options, async (guard, current, boot) => {
    let record = readHostPurge(home);
    if (record && record.id !== id) {
      if (record.phase !== 'complete') throw new Error('Another purge remains unfinished');
      record = null;
    }
    if (record?.phase === 'complete') {
      // A completed archived receipt needs no mutation. An active completed
      // journal still fences installation until its hand-off is durable.
      try {
        lstatSync(join(home, 'installation/removal/purge.json'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return projectHostPurge(record);
        throw error;
      }
      const evidence = await verifyServices(guard, id, options, record.boot_id !== boot);
      if (record.boot_id === boot || evidence.fingerprint !== record.removal_digest)
        throw new Error('Purge completion evidence changed');
      await executePurgeData(guard, record, current);
      return projectHostPurge(record);
    }
    const evidence = await verifyServices(guard, id, options, !!record && record.boot_id !== boot);
    current();
    if (record && record.removal_digest !== evidence.fingerprint)
      throw new Error('Removal evidence changed after purge preparation');
    if (!record) {
      await removalRemoteAccess(guard, 'verify', options.authorised, options.run);
      await retirePurgeRuntimes(guard, current, options.run);
      current();
      record = {
        format: 1,
        id,
        boot_id: boot,
        removal_digest: evidence.fingerprint,
        phase: 'waiting',
        fingerprint: null,
        worktree_fingerprint: null,
        roots: [],
        worktrees: [],
        attempt_id: null,
      };
      writeHostPurge(home, record);
    }
    if (record.boot_id === boot) return projectHostPurge(record);
    if (record.phase === 'waiting') {
      // Revisit exact ended owners before any supporting evidence can detach,
      // including a waiting receipt written by an earlier compatible daemon.
      await retirePurgeRuntimes(guard, current, options.run);
      const review = await reviewPurgeData(home, current);
      record = { ...record, ...review, fingerprint: purgeFingerprint(id, review) };
      current();
      writeHostPurge(home, record);
    }
    return projectHostPurge(record, true);
  });
}

/** Exact approval; uncertain replies are inspected, never automatically dispatched again. */
export async function applyHostPurge(
  home: string,
  release: string,
  input: HostPurgeApply,
  options: Options,
): Promise<void> {
  const request = hostPurgeApplySchema.parse(input);
  await withPurge(home, release, options, async (guard, current, boot) => {
    const record = readHostPurge(home);
    if (!record || record.id !== request.id || record.fingerprint !== request.fingerprint)
      throw new Error('Purge review changed');
    if (record.phase === 'complete') throw new Error('Purge has already completed');
    if (record.boot_id === boot) throw new Error('Reboot the host before purging retained data');
    const evidence = await verifyServices(guard, record.id, options, true);
    current();
    if (evidence.fingerprint !== record.removal_digest)
      throw new Error('Purge removal evidence changed');
    if (record.phase === 'waiting') {
      await retirePurgeRuntimes(guard, current, options.run);
      const review = await reviewPurgeData(home, current);
      if (purgeFingerprint(record.id, review) !== record.fingerprint)
        throw new Error('Purge data or worktree review changed');
      await removalRemoteAccess(guard, 'verify', options.authorised, options.run);
    } else if (record.roots.some((root) => root.name === 'worktrees' && root.state === 'planned')) {
      let remains = true;
      try {
        lstatSync(join(home, 'worktrees'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        remains = false;
      }
      if (remains) {
        const review = await reviewPurgeWorktrees(home, current);
        if (review.fingerprint !== record.worktree_fingerprint)
          throw new Error('Undetached worktrees changed during purge continuation');
      }
      // A crash may have renamed the root before saving "detached". Execution
      // requires its exact reviewed inode in quarantine before deleting anything.
    }
    current();
    requireNoRuntimeMemoryGrants(home);
    record.phase = 'deleting';
    record.attempt_id = request.attempt_id;
    writeHostPurge(home, record);
    await executePurgeData(guard, record, current);
  });
}
