import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import {
  HOST_PURGE_RECORD_BYTES,
  hostPurgeRecordSchema,
  type HostPurgeRecord,
} from '../../installation/removal/purge.js';
import { digest, privatePath, readPrivateJson } from '../security.js';

export function hostPurgeFingerprint(
  id: string,
  review: {
    roots: HostPurgeRecord['roots'];
    worktrees: HostPurgeRecord['worktrees'];
    worktree_fingerprint: string;
  },
): string {
  return digest(JSON.stringify({ id, ...review }));
}

export function validateHostPurgeRecord(value: unknown): HostPurgeRecord {
  const record = hostPurgeRecordSchema.parse(value);
  if (Buffer.byteLength(JSON.stringify(record) + '\n') > HOST_PURGE_RECORD_BYTES)
    throw new Error('Purge evidence exceeds its private record limit');
  if (
    record.fingerprint &&
    record.fingerprint !==
      hostPurgeFingerprint(record.id, {
        roots: record.roots.map((root) => ({ ...root, state: 'planned' })),
        worktrees: record.worktrees,
        worktree_fingerprint: record.worktree_fingerprint!,
      })
  )
    throw new Error('Purge inventory no longer matches its exact approval');
  return record;
}

/** Private recorded evidence only; never service liveness or permission to restore configuration. */
export function readHostPurgeRecord(home: string): HostPurgeRecord | null {
  try {
    privatePath(join(home, 'installation'), true);
    privatePath(join(home, 'installation/removal'), true);
    try {
      return validateHostPurgeRecord(
        readPrivateJson(join(home, 'installation/removal/purge.json'), HOST_PURGE_RECORD_BYTES),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return validateHostPurgeRecord(
        readPrivateJson(join(home, 'installation/removal/purged.json'), HOST_PURGE_RECORD_BYTES),
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function requireArchivedHostPurge(home: string, record: HostPurgeRecord): void {
  if (record.phase !== 'complete')
    throw new Error('Complete the recorded data purge before restoring services');
  try {
    lstatSync(join(home, 'installation/removal/purge.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Complete the recorded purge hand-off before restoring services');
}
