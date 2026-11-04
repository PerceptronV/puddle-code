import { lstatSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_REMOVAL_SERVICES_BYTES } from '@puddle/shared';
import { privatePath } from '@puddle/shared/node';
import { inspectHostRemoval, validateHostRemovalServices } from '@puddle/shared/node/host-control';
import type { RuntimeStore } from '../../../db/stores/runtimes.js';
import type { HostRemovalGuard } from '../../removal/guard.js';
import { optionalRecord, ReleaseReferenceInventory } from './inventory.js';
import { retainRuntimeReleases } from './runtimes.js';
import { retainUpdateReleases } from './updates.js';
import { withReleaseCollectionExclusion } from './exclusion.js';

/** Offline collection review under retained installer/update/controller exclusion. No deletions. */
export async function reviewReleaseCollection(
  guard: HostRemovalGuard,
  runtimes: Pick<RuntimeStore, 'releaseReferences' | 'get'>,
  authorised: () => boolean,
  now = Date.now(),
) {
  return withReleaseCollectionExclusion(guard, authorised, (requireCurrent) =>
    inspectReleaseReferences(guard.home, runtimes, requireCurrent, now),
  );
}

/** Internal inspection; callers retain collection exclusion through any resulting mutation. */
export async function inspectReleaseReferences(
  home: string,
  runtimes: Pick<RuntimeStore, 'releaseReferences' | 'get'>,
  requireCurrent: () => void,
  now = Date.now(),
) {
  const index = new ReleaseReferenceInventory(home, requireCurrent);
  await index.inspect();
  // The collecting helper may itself be running from an older immutable generation.
  for (const executable of [process.execPath, fileURLToPath(import.meta.url)]) {
    const path = realpathSync(executable);
    const parts = relative(index.versions, path).split(sep);
    if (parts.length > 1 && parts[0] !== '..')
      index.add(join(index.versions, parts[0]!), 'collection-process');
  }
  for (const selector of ['current', 'runtime-current']) {
    const path = join(home, 'bin', selector);
    try {
      if (!lstatSync(path).isSymbolicLink()) throw new Error('Release selector is not a link');
    } catch (error) {
      if (selector === 'runtime-current' && (error as NodeJS.ErrnoException).code === 'ENOENT')
        continue;
      throw error;
    }
    index.add(realpathSync(path), `selector:${selector}`);
  }
  await retainRuntimeReleases(index, runtimes);
  await retainUpdateReleases(index);
  inspectHostRemoval(home);
  try {
    privatePath(join(home, 'installation'), true);
    privatePath(join(home, 'installation/removal'), true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const name of [
    'services.json',
    'restored-services.json',
    'cancelled-services.json',
    'purged-services.json',
  ]) {
    const value = optionalRecord(
      join(home, 'installation/removal', name),
      HOST_REMOVAL_SERVICES_BYTES,
    );
    if (value) {
      const record = validateHostRemovalServices(value);
      index.add(record.release_path, `removal:${record.id}`);
    }
  }
  return index.finish(now);
}
