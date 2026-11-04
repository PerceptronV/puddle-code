import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { HOST_REMOVAL_SERVICES_BYTES } from '@puddle/shared';
import { atomicPrivateJson, digest, readPrivateJson } from '@puddle/shared/node';
import {
  readHostBootIdentity,
  readHostPurgeRecord,
  readPurgedHostRemoval,
  requireArchivedHostPurge,
  validateHostRemovalServices,
} from '@puddle/shared/node/host-control';
import type { HostRemovalGuard } from '../guard.js';

export interface PurgedRestoration {
  digest: string;
  requireCurrent(): void;
}

/** Reconstitute unchanged service intent only after exact archived purge and prior-boot proof. */
export async function preparePurgedRestoration(
  guard: HostRemovalGuard,
  id: string,
  authorised: () => boolean,
  bootIdentity: () => Promise<string | null> = readHostBootIdentity,
): Promise<PurgedRestoration | undefined> {
  guard.requireController();
  const purge = readHostPurgeRecord(guard.home);
  if (!purge) return;
  requireArchivedHostPurge(guard.home, purge);
  if (purge.id !== id) return;
  const proof = readPurgedHostRemoval(guard.home);
  if (!proof || proof.services.id !== id) throw new Error('Missing exact completed purge evidence');
  const boot = await bootIdentity();
  if (!boot || boot === proof.purge.boot_id)
    throw new Error('Prior-boot purge evidence is unavailable');
  const requireCurrent = () => {
    guard.requireController();
    if (!authorised() || readPurgedHostRemoval(guard.home)?.digest !== proof.digest)
      throw new Error('Completed purge evidence or restoration authority changed');
  };
  requireCurrent();
  const file = join(guard.home, 'installation/removal/services.json');
  let active = null;
  try {
    active = validateHostRemovalServices(readPrivateJson(file, HOST_REMOVAL_SERVICES_BYTES));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (active) {
    if (digest(JSON.stringify(active)) !== digest(JSON.stringify(proof.services)))
      throw new Error('Active removal differs from the completed purge');
  } else {
    try {
      lstatSync(join(guard.home, 'puddle.db'));
      throw new Error('Fresh host data already exists after purge');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    requireCurrent();
    atomicPrivateJson(file, proof.services, { syncDirectory: true });
  }
  return { digest: proof.digest, requireCurrent };
}
