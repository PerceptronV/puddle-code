import { join } from 'node:path';
import { hostUpdateOperationSchema, type HostUpdateOperation } from '../../installation/update.js';
import {
  HOST_UPDATE_RECOVERY_BYTES,
  hostUpdateRecoveryLedgerSchema,
  type HostUpdateRecoveryLedger,
} from '../../installation/recovery.js';
import { privatePath, readPrivateJson } from '../security.js';

export function updateRecoveryDirectory(home: string, operationId: string): string {
  hostUpdateOperationSchema.shape.id.parse(operationId);
  return join(home, 'updates/jobs', operationId, 'recovery');
}

/** An absent ledger precedes any recovery dispatch; every accepted attempt is retained. */
export function readUpdateRecoveryAttempts(
  home: string,
  operationId: string,
): HostUpdateRecoveryLedger {
  const directory = updateRecoveryDirectory(home, operationId);
  try {
    privatePath(directory, true);
    const ledger = hostUpdateRecoveryLedgerSchema.parse(
      readPrivateJson(join(directory, 'attempts.json'), HOST_UPDATE_RECOVERY_BYTES),
    );
    if (ledger.attempts.some(({ job }) => job.operation_id !== operationId))
      throw new Error('Recovery ledger belongs to another update');
    return ledger;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { format: 1, attempts: [] };
    throw error;
  }
}

/** Public recorded acceptance only; no executable paths or process identifiers leave the host. */
export function inspectRecordedRecovery(home: string, operation: HostUpdateOperation) {
  const attempt = readUpdateRecoveryAttempts(home, operation.id).attempts.at(-1);
  if (!attempt) return undefined;
  const { job, execution } = attempt;
  if (
    job.original_dispatch_id !== operation.dispatch_id ||
    job.original_worker_id !== operation.worker_id ||
    job.preflight !== operation.approved
  )
    throw new Error('Recovery record does not match this update');
  return {
    id: job.id,
    requested_revision: job.requested_revision,
    revision: job.revision,
    consumed: execution !== null,
  };
}
