import { join } from 'node:path';
import { existsSync, lstatSync } from 'node:fs';
import { hostPurgeReviewSchema, type HostPurgeRecord, type HostPurgeReview } from '@puddle/shared';
import { atomicPrivateJson } from '@puddle/shared/node';
import { readHostPurgeRecord, validateHostPurgeRecord } from '@puddle/shared/node/host-control';

export function writeHostPurge(home: string, record: HostPurgeRecord): void {
  atomicPrivateJson(
    join(home, 'installation/removal/purge.json'),
    validateHostPurgeRecord(record),
    {
      syncDirectory: true,
    },
  );
}

export function projectHostPurge(record: HostPurgeRecord, ready = false): HostPurgeReview {
  return hostPurgeReviewSchema.parse({
    id: record.id,
    phase: record.phase === 'waiting' ? (ready ? 'ready' : 'reboot_required') : record.phase,
    fingerprint: record.fingerprint,
    worktrees: record.worktrees,
    attempt_id: record.attempt_id,
  });
}

/** Recorded outcome only: this read never proves fresh process or service absence. */
export function inspectHostPurge(home: string): HostPurgeReview | null {
  const record = readHostPurgeRecord(home);
  if (record?.phase === 'complete') {
    if (existsSync(join(home, 'installation/removal/purge.json')))
      return projectHostPurge({ ...record, phase: 'deleting' });
    try {
      lstatSync(join(home, 'puddle.db'));
      // A fresh installation has its own future removal, not the old purge.
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return record ? projectHostPurge(record) : null;
}
