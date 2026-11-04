import { hostUpdateOperationSchema, type HostUpdateOperation } from '@puddle/shared';
import { acquireHostClaim } from '../../security/claims.js';
import { HostUpdateOperations } from '../operations/store.js';
import { requireVerificationOperation } from '../verification/operation.js';
import { requireEndedUpdateWorker } from '../worker/lifetime.js';
import { readUpdateWorker } from '../worker/supervisor.js';

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
  const release = () => {
    if (released) return;
    released = true;
    try {
      recovery?.release();
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
      if (released) throw new Error('Host recovery claim is released');
      requireAuthority();
      requireVerificationOperation(home, operation, job);
      requireEndedUpdateWorker(home, job, operation);
    };
    check();
    return {
      operation,
      job,
      check,
      release,
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
