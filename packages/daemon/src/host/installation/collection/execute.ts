import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync, renameSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  HOST_RELEASE_COLLECTION_BYTES,
  HOST_RELEASE_COLLECTION_LIMIT,
  hostReleaseCollectionSchema,
  type HostReleaseCollection,
} from '@puddle/shared';
import {
  atomicPrivateJson,
  privateDirectory,
  privatePath,
  syncPrivateDirectory,
} from '@puddle/shared/node';
import type { RuntimeStore } from '../../../db/stores/runtimes.js';
import type { ReleaseCollectionGuard } from './guard.js';
import type { CollectionBudget } from './budget.js';
import { HostActionWriter } from '../action-writer.js';
import { withReleaseCollectionExclusion } from './exclusion.js';
import { boundedDirectories, optionalRecord, type RetainedRelease } from './inventory.js';
import { inspectReleaseReferences } from './review.js';
import { pruneOwnedTree, OWNED_TREE_FILE_BUDGET, syncOwnedDirectory } from '../tree.js';

type RuntimeReferences = Pick<RuntimeStore, 'releaseReferences' | 'get'>;
type Release = HostReleaseCollection['releases'][number];
type Persistence = { write?: typeof atomicPrivateJson; budget?: CollectionBudget };

function paths(home: string) {
  const directory = join(home, 'installation/collection');
  return {
    directory,
    journal: join(directory, 'current.json'),
    quarantine: join(home, 'bin/.collection'),
  };
}

/** Recorded progress only, never proof that a release remains unreferenced. */
export function inspectReleaseCollection(
  guard: ReleaseCollectionGuard,
): HostReleaseCollection | null {
  guard.requireController();
  const { directory, journal } = paths(guard.home);
  try {
    privatePath(join(guard.home, 'installation'), true);
    privatePath(directory, true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const value = optionalRecord(journal, HOST_RELEASE_COLLECTION_BYTES);
  if (value === null) return null;
  const record = hostReleaseCollectionSchema.parse(value);
  if (record.home !== realpathSync(guard.home))
    throw new Error('Collection belongs to another home');
  return record;
}

/** Accept only the reviewed candidates, capped to one bounded batch. No release files change. */
export async function prepareReleaseCollection(
  guard: ReleaseCollectionGuard,
  runtimes: RuntimeReferences,
  fingerprint: string,
  authorised: () => boolean,
  persistence: Persistence = {},
): Promise<HostReleaseCollection | null> {
  return withReleaseCollectionExclusion(guard, authorised, async (requireCurrent) => {
    const review = await inspectReleaseReferences(
      guard.home,
      runtimes,
      requireCurrent,
      Date.now(),
      persistence.budget,
    );
    if (review.fingerprint !== fingerprint) throw new Error('Release collection review changed');
    const previous = inspectReleaseCollection(guard);
    if (previous?.actions.some(({ state }) => state !== 'finished'))
      throw new Error('Continue the existing release collection first');
    const locations = paths(guard.home);
    for (const id of await boundedDirectories(
      locations.quarantine,
      requireCurrent,
      true,
      persistence.budget,
    )) {
      if (id !== previous?.id) throw new Error('Unknown release collection quarantine');
      // A completed batch can leave its empty container after losing the last reply.
      rmdirSync(join(locations.quarantine, id));
      syncPrivateDirectory(locations.quarantine);
    }
    const selected = new Set(review.candidates.slice(0, HOST_RELEASE_COLLECTION_LIMIT));
    if (!selected.size) return null;
    const initial = hostReleaseCollectionSchema.parse({
      format: 1,
      id: randomUUID(),
      home: realpathSync(guard.home),
      fingerprint,
      releases: review.releases
        .filter(({ path }) => selected.has(path))
        .map(({ generation, device, inode, receipt, publishedAt }) => ({
          generation,
          device,
          inode,
          receipt,
          publishedAt,
        })),
      actions: review.releases
        .filter(({ path }) => selected.has(path))
        .map(({ generation }) => ({ action: generation, state: 'planned' })),
    });
    requireCurrent();
    privateDirectory(join(guard.home, 'installation'));
    privateDirectory(locations.directory);
    if (previous) {
      const last = join(locations.directory, 'last.json');
      // Do not overwrite an unsafe/unknown retained journal.
      const retained = optionalRecord(last, HOST_RELEASE_COLLECTION_BYTES);
      if (retained !== null) hostReleaseCollectionSchema.parse(retained);
      renameSync(locations.journal, last);
      syncPrivateDirectory(locations.directory);
    }
    new HostActionWriter({
      path: locations.journal,
      initial,
      parse: hostReleaseCollectionSchema.parse,
      maxBytes: HOST_RELEASE_COLLECTION_BYTES,
      requireCurrent,
      write: persistence.write,
    });
    return initial;
  });
}

/** Explicit, bounded reconciliation of filesystem intent, including an interrupted rename/deletion. */
export async function executeReleaseCollection(
  guard: ReleaseCollectionGuard,
  runtimes: RuntimeReferences,
  id: string,
  authorised: () => boolean,
  persistence: Persistence = {},
) {
  return withReleaseCollectionExclusion(guard, authorised, async (requireCurrent) => {
    const initial = inspectReleaseCollection(guard);
    if (!initial || initial.id !== id) throw new Error('Release collection identity changed');
    const locations = paths(guard.home);
    privatePath(join(guard.home, 'bin'), true);
    privateDirectory(locations.quarantine);
    for (const entry of await boundedDirectories(
      locations.quarantine,
      requireCurrent,
      true,
      persistence.budget,
    ))
      if (entry !== id) throw new Error('Unknown release collection quarantine');
    const quarantine = join(locations.quarantine, id);
    privateDirectory(quarantine);
    for (const generation of await boundedDirectories(
      quarantine,
      requireCurrent,
      false,
      persistence.budget,
    ))
      if (!initial.releases.some((release) => release.generation === generation))
        throw new Error('Unknown quarantined release');
    const writer = new HostActionWriter({
      path: locations.journal,
      initial,
      parse: hostReleaseCollectionSchema.parse,
      maxBytes: HOST_RELEASE_COLLECTION_BYTES,
      requireCurrent,
      resume: true,
      write: persistence.write,
    });
    const budget = { remaining: OWNED_TREE_FILE_BUDGET };
    for (const release of initial.releases) {
      const action = writer.read().actions.find(({ action }) => action === release.generation)!;
      const source = join(guard.home, 'bin/versions', release.generation);
      const target = join(quarantine, release.generation);
      if (action.state === 'finished') {
        if (stat(target)) throw new Error('Finished collection still has quarantined files');
        continue;
      }
      if (!budget.remaining) break;
      const reconcile = async () => {
        const review = await inspectReleaseReferences(
          guard.home,
          runtimes,
          requireCurrent,
          Date.now(),
          persistence.budget,
        );
        requireCurrent();
        const original = stat(source);
        const detached = stat(target);
        if (original) {
          if (detached) throw new Error('Collection release exists in two locations');
          const current = review.releases.find(({ path }) => path === realpathSync(source));
          if (
            !current ||
            !review.candidates.includes(current.path) ||
            !sameRelease(current, release)
          )
            throw new Error('Collection release is no longer eligible');
          requireIdentity(source, release);
          renameSync(source, target);
        } else if (detached) requireIdentity(target, release);
        else if (action.state === 'planned')
          throw new Error('Unattempted collection release disappeared');
        // Both sides are synced even on recovery from a lost rename reply.
        syncOwnedDirectory(join(guard.home, 'bin/versions'));
        syncPrivateDirectory(quarantine);
        requireCurrent();
        if (stat(source)) throw new Error('Collection source reappeared');
        if (stat(target)) {
          const complete = await pruneOwnedTree(
            target,
            release,
            () => {
              requireCurrent();
              privatePath(locations.quarantine, true);
              privatePath(quarantine, true);
              if (stat(source)) throw new Error('Collection source reappeared');
            },
            budget,
          );
          if (!complete) throw new CollectionBatchPending();
        }
        syncPrivateDirectory(quarantine);
      };
      try {
        if (action.state === 'planned') await writer.run(action.action, reconcile);
        else {
          // Local unlink/rmdir/rename converge on a recorded inode, unlike replaying a service command.
          // Complete that bounded reconciliation first; observe only the resulting absence.
          await reconcile();
          await writer.observe(action.action, async () => {
            if (stat(source) || stat(target)) throw new Error('Collection release still exists');
            syncPrivateDirectory(quarantine);
          });
        }
      } catch (error) {
        if (!(error instanceof CollectionBatchPending)) throw error;
        break;
      }
    }
    const remaining = writer.read().actions.filter(({ state }) => state !== 'finished').length;
    if (!remaining) {
      requireCurrent();
      rmdirSync(quarantine);
      syncPrivateDirectory(locations.quarantine);
    }
    return { id, complete: remaining === 0, remaining };
  });
}

class CollectionBatchPending extends Error {}

function stat(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function requireIdentity(path: string, release: Release): void {
  const info = lstatSync(path);
  if (
    !info.isDirectory() ||
    info.dev !== release.device ||
    info.ino !== release.inode ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o022) !== 0
  )
    throw new Error('Collection release identity changed');
}

function sameRelease(current: RetainedRelease, accepted: Release): boolean {
  return (
    current.generation === accepted.generation &&
    current.device === accepted.device &&
    current.inode === accepted.inode &&
    current.receipt === accepted.receipt &&
    current.publishedAt === accepted.publishedAt
  );
}
