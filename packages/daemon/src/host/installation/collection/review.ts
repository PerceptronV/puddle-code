import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { HOST_REMOVAL_SERVICES_BYTES } from '@puddle/shared';
import { privatePath } from '@puddle/shared/node';
import { inspectHostRemoval, validateHostRemovalServices } from '@puddle/shared/node/host-control';
import type { RuntimeStore } from '../../../db/stores/runtimes.js';
import { acquireHostClaim } from '../../../security/claims.js';
import type { HostRemovalGuard } from '../../removal/guard.js';
import { optionalRecord, ReleaseReferenceInventory } from './inventory.js';
import { retainRuntimeReleases } from './runtimes.js';
import { retainUpdateReleases } from './updates.js';

/** Offline collection review under retained installer/update/controller exclusion. No deletions. */
export async function reviewReleaseCollection(
  guard: HostRemovalGuard,
  runtimes: Pick<RuntimeStore, 'releaseReferences' | 'get'>,
  authorised: () => boolean,
  now = Date.now(),
) {
  const deadline = performance.now() + 30_000;
  const requireCurrent = () => {
    guard.requireController();
    if (!authorised()) throw new Error('Release collection authority expired');
    if (performance.now() > deadline)
      throw new Error('Release collection review deadline exceeded');
  };
  requireCurrent();
  const control = acquireHostClaim(guard.home, 'host-update-control');
  try {
    const index = new ReleaseReferenceInventory(guard.home, requireCurrent);
    await index.inspect();
    for (const selector of ['current', 'runtime-current']) {
      const path = join(guard.home, 'bin', selector);
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
    const removal = inspectHostRemoval(guard.home);
    if (removal.state !== 'none') privatePath(join(guard.home, 'installation/removal'), true);
    for (const name of ['services.json', 'restored-services.json', 'cancelled-services.json']) {
      const value = optionalRecord(
        join(guard.home, 'installation/removal', name),
        HOST_REMOVAL_SERVICES_BYTES,
      );
      if (value) {
        const record = validateHostRemovalServices(value);
        index.add(record.release_path, `removal:${record.id}`);
      }
    }
    return index.finish(now);
  } finally {
    control.release();
  }
}
