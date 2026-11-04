import {
  readUpdateRecoveryAttempts,
  updateRecoveryDirectory,
} from '@puddle/shared/node/host-control';
import { join } from 'node:path';
import {
  hostUpdateActionsSchema,
  type HostUpdateOperation,
  type HostUpdateWorker,
} from '@puddle/shared';
import { digest, readPrivateJson } from '@puddle/shared/node';
import { readUpdateActions } from '../worker/actions.js';

/** Merge all retained intent: a newer journal must never turn attempted work back into planned work. */
export function readRecoveryActions(
  home: string,
  original: HostUpdateWorker,
  operation: HostUpdateOperation,
  beforeAttempt?: string,
) {
  const progress = readUpdateActions(home, original, operation);
  const identity = (record: typeof progress) => ({
    ...record,
    worker_id: operation.worker_id,
    actions: record.actions.map(({ action }) => action),
  });
  const originalDigest = digest(JSON.stringify(original));
  const rank = { planned: 0, started: 1, finished: 2 } as const;
  for (const { job, execution } of readUpdateRecoveryAttempts(home, operation.id).attempts) {
    if (
      job.original_dispatch_id !== operation.dispatch_id ||
      job.original_worker_id !== operation.worker_id ||
      job.preflight !== operation.approved ||
      job.original_worker_digest !== originalDigest ||
      job.actions_digest !== digest(JSON.stringify(progress))
    )
      throw new Error('Recovery attempt does not match retained step evidence');
    if (job.id === beforeAttempt) return progress;
    if (!execution) continue;
    const journal = hostUpdateActionsSchema.parse(
      readPrivateJson(
        join(updateRecoveryDirectory(home, operation.id), job.id, 'actions.json'),
        4096,
      ),
    );
    if (
      journal.worker_id !== execution.id ||
      JSON.stringify(identity(journal)) !== JSON.stringify(identity(progress))
    )
      throw new Error('Recovery action journal does not match its consumed worker');
    for (const [index, action] of journal.actions.entries()) {
      const previous = progress.actions[index]!;
      if (rank[action.state] > rank[previous.state]) previous.state = action.state;
    }
  }
  if (beforeAttempt) throw new Error('Missing accepted recovery attempt');
  return hostUpdateActionsSchema.parse(progress);
}
