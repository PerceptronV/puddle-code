import { join } from 'node:path';
import { lstatSync } from 'node:fs';
import {
  HOST_REMOVAL_SERVICES_BYTES,
  hostRemovalRestoreSchema,
  hostRemovalRestorePlan,
  hostRemovalServicesSchema,
  hostRemovalFinishSchema,
  type HostRemovalServices,
  type HostRemovalStatus,
} from '../../index.js';
import { digest, privatePath, readPrivateJson } from '../security.js';
import { readHostPurgeRecord, requireArchivedHostPurge } from './purge.js';

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

/** Completed archived proof only. Process absence still requires the current kernel boot identity. */
export function readPurgedHostRemoval(home: string) {
  const purge = readHostPurgeRecord(home);
  if (!purge) return null;
  requireArchivedHostPurge(home, purge);
  const directory = join(home, 'installation/removal');
  const result = hostRemovalFinishSchema.parse(
    readPrivateJson(join(directory, 'result.json'), 4096),
  );
  // A later removal supersedes a historical purge receipt.
  if (result.id !== purge.id) return null;
  const services = validateHostRemovalServices(
    readPrivateJson(join(directory, 'purged-services.json'), HOST_REMOVAL_SERVICES_BYTES),
  );
  if (
    services.id !== purge.id ||
    result.disposition !== 'stop' ||
    services.actions.some(({ state }) => state !== 'finished') ||
    digest(JSON.stringify({ record: services, result })) !== purge.removal_digest
  )
    throw new Error('Completed purge does not match its removal evidence');
  return { purge, services, digest: digest(JSON.stringify(purge)) };
}

function hasDatabase(home: string): boolean {
  try {
    const info = lstatSync(join(home, 'puddle.db'));
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0)
      throw new Error('Unsafe current host database');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
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
  if (!active) {
    const purge = readHostPurgeRecord(home);
    if (purge) {
      try {
        requireArchivedHostPurge(home, purge);
      } catch {
        return { state: 'removing', id: purge.id };
      }
    }
  }
  const purged = !active && !hasDatabase(home) ? readPurgedHostRemoval(home) : null;
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
        JSON.stringify(hostRemovalRestorePlan(archive, Boolean(restore.purge_digest))) ||
      restore.actions.some(({ state }) => state !== 'finished') ||
      archive.actions.some(({ state }) => state !== 'finished')
    )
      throw new Error('Previous restoration is unresolved');
    if (!active && (!purged || purged.services.id === archive.id))
      return { state: 'restored', id: archive.id };
  }
  if (!active) {
    if (purged) return { state: 'removed', id: purged.services.id };
    if (readServices('restored-services.json'))
      throw new Error('Missing restoration evidence for the retained removal');
    return { state: 'none' };
  }
  if (restore?.removal_id === active.id) {
    if (
      restore.removal_digest !== digest(JSON.stringify(active)) ||
      JSON.stringify(restore.actions.map(({ action }) => action)) !==
        JSON.stringify(hostRemovalRestorePlan(active, Boolean(restore.purge_digest))) ||
      active.actions.some(({ state }) => state !== 'finished')
    )
      throw new Error('Restoration does not match completed removal');
    if (restore.purge_digest && readPurgedHostRemoval(home)?.digest !== restore.purge_digest)
      throw new Error('Restoration no longer matches its completed purge');
    return { state: 'restoring', id: active.id };
  }
  return {
    state: active.actions.every(({ state }) => state === 'finished') ? 'removed' : 'removing',
    id: active.id,
  };
}
