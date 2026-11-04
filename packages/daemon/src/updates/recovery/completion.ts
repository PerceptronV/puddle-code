import { hostUpdateOperationSchema, type HostUpdateOperation } from '@puddle/shared';
import type { CompilationCommandRunner } from '../../compilation/process.js';
import { acquireHostClaim } from '../../security/claims.js';
import { HostUpdateOperations } from '../operations/store.js';
import { requireEndedUpdateWorker } from '../worker/lifetime.js';
import { readUpdateWorker } from '../worker/supervisor.js';
import { verifyHostUpdateCompletion } from '../verification/completion.js';

/** Explicitly finish a completed installation; no component command is replayed. */
export async function recoverCompletedHostUpdate(
  home: string,
  reference: Pick<HostUpdateOperation, 'id' | 'revision'>,
  authorised: () => boolean,
  run?: CompilationCommandRunner,
): Promise<HostUpdateOperation> {
  hostUpdateOperationSchema.shape.id.parse(reference.id);
  const requireAuthority = () => {
    if (!authorised()) throw new Error('Host recovery authority expired');
  };
  requireAuthority();
  // Do not race a dispatcher still delivering its original supervisor command.
  const dispatch = acquireHostClaim(home, `host-update-dispatch:${reference.id}`);
  let recovery: ReturnType<HostUpdateOperations['claimRecovery']> | undefined;
  try {
    const store = new HostUpdateOperations(home);
    requireAuthority();
    recovery = store.claimRecovery(reference);
    const operation = recovery.operation;
    const job = readUpdateWorker(home, operation.id);
    requireEndedUpdateWorker(home, job, operation);
    const verification = await verifyHostUpdateCompletion(home, job, operation, run);
    requireEndedUpdateWorker(home, job, operation);
    requireAuthority();
    return recovery.complete(verification);
  } finally {
    recovery?.release();
    dispatch.release();
  }
}
