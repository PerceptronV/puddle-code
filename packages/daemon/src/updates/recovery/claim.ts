import { hostUpdateOperationSchema, type HostUpdateOperation } from '@puddle/shared';
import { acquireHostClaim } from '../../security/claims.js';
import { HostUpdateOperations } from '../operations/store.js';
import { requireVerificationOperation } from '../verification/operation.js';
import { requireEndedUpdateWorker } from '../worker/lifetime.js';
import { readUpdateWorker } from '../worker/supervisor.js';
import { requireEndedUpdateRecoveryWorkers } from './worker/records.js';

/** Fence original dispatch/execution and retain exclusion throughout explicit recovery. */
export function claimHostUpdateRecovery(
  home: string,
  reference: Pick<HostUpdateOperation, 'id' | 'revision'>,
  authorised: () => boolean,
) {
  hostUpdateOperationSchema.shape.id.parse(reference.id);
  const requireAuthority = () => {
    if (!authorised()) throw new Error('Host recovery authority expired');
  };
  requireAuthority();
  const dispatch = acquireHostClaim(home, `host-update-dispatch:${reference.id}`);
  let recovery: ReturnType<HostUpdateOperations['claimRecovery']> | undefined;
  let released = false;
  let executionReleased = false;
  const releaseExecution = () => {
    if (executionReleased) return;
    executionReleased = true;
    recovery?.release();
  };
  const release = () => {
    if (released) return;
    released = true;
    try {
      releaseExecution();
    } finally {
      dispatch.release();
    }
  };
  try {
    requireAuthority();
    recovery = new HostUpdateOperations(home).claimRecovery(reference);
    const operation = recovery.operation;
    const job = readUpdateWorker(home, operation.id);
    const check = () => {
      if (released || executionReleased) throw new Error('Host recovery claim is released');
      requireAuthority();
      requireVerificationOperation(home, operation, job);
      requireEndedUpdateWorker(home, job, operation);
      requireEndedUpdateRecoveryWorkers(home, operation);
    };
    check();
    return {
      operation,
      job,
      check,
      release,
      // The accepted independent job must be able to acquire execution while
      // the dispatcher still holds its claim across the supervisor command.
      releaseExecution,
      complete: (verification: string) => {
        check();
        return recovery!.complete(verification);
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}
