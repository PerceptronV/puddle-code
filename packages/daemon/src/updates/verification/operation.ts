import {
  hostUpdateOperationSchema,
  type HostUpdateOperation,
  type HostUpdateWorker,
} from '@puddle/shared';
import { HostUpdateOperations } from '../operations/store.js';

/** Verification never changes a phase or grants permission to repeat a worker command. */
export function requireVerificationOperation(
  home: string,
  input: HostUpdateOperation,
  job?: HostUpdateWorker,
): HostUpdateOperation {
  const operation = hostUpdateOperationSchema.parse(input);
  if (
    !['verifying', 'recovery_required'].includes(operation.phase) ||
    !operation.worker_id ||
    (job &&
      (job.operation_id !== operation.id ||
        job.dispatch_id !== operation.dispatch_id ||
        job.preflight !== operation.approved ||
        operation.revision < job.dispatch_revision + 2)) ||
    JSON.stringify(new HostUpdateOperations(home).read(operation.id)) !== JSON.stringify(operation)
  )
    throw new Error('Host update changed before completion verification');
  return operation;
}
