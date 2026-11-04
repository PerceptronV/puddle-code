import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  HOST_UPDATE_RECOVERY_ATTEMPTS,
  HOST_UPDATE_RECOVERY_BYTES,
  hostUpdateOperationSchema,
  hostUpdateRecoveryAttemptSchema,
  hostUpdateRecoveryJobSchema,
  hostUpdateRecoveryLedgerSchema,
  type HostUpdateOperation,
  type HostUpdateRecoveryJob,
  type HostUpdateRecoveryLedger,
} from '@puddle/shared';
import {
  atomicPrivateJson,
  privateDirectory,
  privatePath,
  readPrivateJson,
  syncPrivateDirectory,
} from '@puddle/shared/node';
import { acquireHostClaim } from '../../../security/claims.js';
import { requireEndedUpdateProcessGroup } from '../../worker/lifetime.js';

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

/** Caller holds update execution; this short claim also serialises dispatch acknowledgement. */
export class HostUpdateRecoveryAttempts {
  constructor(
    private readonly home: string,
    private readonly operationId: string,
  ) {
    const directory = updateRecoveryDirectory(home, operationId);
    privateDirectory(directory);
    syncPrivateDirectory(dirname(directory));
  }

  append(input: HostUpdateRecoveryJob, requireCurrent: () => void) {
    const job = hostUpdateRecoveryJobSchema.parse(input);
    if (job.operation_id !== this.operationId)
      throw new Error('Recovery job belongs to another update');
    return this.change((ledger) => {
      if (ledger.attempts.some(({ job: previous }) => previous.id === job.id))
        throw new Error('Recovery dispatch was already recorded');
      if (ledger.attempts.length === HOST_UPDATE_RECOVERY_ATTEMPTS)
        throw new Error('Host update recovery attempt limit reached');
      const attempt = hostUpdateRecoveryAttemptSchema.parse({ job, execution: null });
      ledger.attempts.push(attempt);
      requireCurrent();
      return attempt;
    });
  }

  /** One durable consumption, before any component command; repeats never create another worker. */
  claim(input: HostUpdateRecoveryJob, processGroup: number, requireCurrent: () => void) {
    const job = hostUpdateRecoveryJobSchema.parse(input);
    return this.change((ledger) => {
      const attempt = ledger.attempts.find(({ job: recorded }) => recorded.id === job.id);
      if (!attempt || JSON.stringify(attempt.job) !== JSON.stringify(job) || attempt.execution)
        throw new Error('Recovery worker does not match an unconsumed dispatch');
      attempt.execution = hostUpdateRecoveryAttemptSchema.shape.execution
        .unwrap()
        .parse({ id: randomUUID(), process_group: processGroup });
      requireCurrent();
      return attempt;
    });
  }

  private change<T>(update: (ledger: HostUpdateRecoveryLedger) => T): T {
    const claim = acquireHostClaim(this.home, `host-update-recovery-records:${this.operationId}`);
    try {
      const ledger = readUpdateRecoveryAttempts(this.home, this.operationId);
      const result = update(ledger);
      const valid = hostUpdateRecoveryLedgerSchema.parse(ledger);
      if (Buffer.byteLength(JSON.stringify(valid)) > HOST_UPDATE_RECOVERY_BYTES)
        throw new Error('Recovery ledger exceeds its byte limit');
      atomicPrivateJson(
        join(updateRecoveryDirectory(this.home, this.operationId), 'attempts.json'),
        valid,
        { syncDirectory: true },
      );
      return structuredClone(result);
    } finally {
      claim.release();
    }
  }
}

/** Pending jobs must be fenced and every consumed worker group must have ended. */
export function requireEndedUpdateRecoveryWorkers(
  home: string,
  operation: HostUpdateOperation,
  current?: { id: string; execution: string; processGroup: number },
): void {
  for (const { job, execution } of readUpdateRecoveryAttempts(home, operation.id).attempts) {
    if (
      job.original_dispatch_id !== operation.dispatch_id ||
      job.original_worker_id !== operation.worker_id ||
      job.preflight !== operation.approved ||
      operation.revision <= job.revision
    )
      throw new Error('Recovery worker is not fenced by this operation');
    if (job.id === current?.id) {
      if (execution?.id !== current.execution || execution.process_group !== current.processGroup)
        throw new Error('Recovery execution identity changed');
    } else if (execution) requireEndedUpdateProcessGroup(execution.process_group);
  }
}
