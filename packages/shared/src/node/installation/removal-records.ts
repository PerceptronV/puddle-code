import { join } from 'node:path';
import {
  HOST_REMOVAL_SERVICES_BYTES,
  hostRemovalRestoreSchema,
  hostRemovalRestorePlan,
  hostRemovalServicesSchema,
  type HostRemovalServices,
  type HostRemovalStatus,
} from '../../index.js';
import { digest, privatePath, readPrivateJson } from '../security.js';

export function validateHostRemovalServices(value: unknown): HostRemovalServices {
  const journal = hostRemovalServicesSchema.parse(value);
  for (const { review, source } of journal.services)
    if (
      Buffer.from(source, 'base64').toString('base64') !== source ||
      digest(source) !== review.sourceDigest
    )
      throw new Error('Removal service source does not match its review');
  return journal;
}

/** Missing evidence is distinct from unreadable, linked or malformed evidence. */
function optionalRecord<T>(path: string, limit: number, parse: (value: unknown) => T): T | null {
  try {
    return parse(readPrivateJson(path, limit));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Never exports saved definitions, environment values, process identities or host paths. */
export function inspectHostRemoval(home: string): HostRemovalStatus {
  for (const directory of ['installation', 'installation/removal']) {
    try {
      privatePath(join(home, directory), true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'none' };
      throw error;
    }
  }
  const directory = join(home, 'installation/removal');
  const readServices = (name: string) =>
    optionalRecord(join(directory, name), HOST_REMOVAL_SERVICES_BYTES, validateHostRemovalServices);
  const active = readServices('services.json');
  const restore = optionalRecord(
    join(directory, 'restore.json'),
    4096,
    hostRemovalRestoreSchema.parse,
  );
  if (restore && restore.removal_id !== active?.id) {
    const archive = readServices('restored-services.json');
    if (
      !archive ||
      restore.removal_id !== archive.id ||
      restore.removal_digest !== digest(JSON.stringify(archive)) ||
      JSON.stringify(restore.actions.map(({ action }) => action)) !==
        JSON.stringify(hostRemovalRestorePlan(archive)) ||
      restore.actions.some(({ state }) => state !== 'finished') ||
      archive.actions.some(({ state }) => state !== 'finished')
    )
      throw new Error('Previous restoration is unresolved');
    if (!active) return { state: 'restored', id: archive.id };
  }
  if (!active) {
    if (readServices('restored-services.json'))
      throw new Error('Missing restoration evidence for the retained removal');
    return { state: 'none' };
  }
  if (restore?.removal_id === active.id) {
    if (
      restore.removal_digest !== digest(JSON.stringify(active)) ||
      JSON.stringify(restore.actions.map(({ action }) => action)) !==
        JSON.stringify(hostRemovalRestorePlan(active)) ||
      active.actions.some(({ state }) => state !== 'finished')
    )
      throw new Error('Restoration does not match completed removal');
    return { state: 'restoring', id: active.id };
  }
  return {
    state: active.actions.every(({ state }) => state === 'finished') ? 'removed' : 'removing',
    id: active.id,
  };
}
