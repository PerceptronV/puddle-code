import type { HostUpdateCheckpointReference, RuntimeControllerRecord } from '@puddle/shared';
import { HostUpdateOperations } from '../operations/store.js';
import { readUpdateWorker } from './supervisor.js';

/** Signal-driven shutdown honours only an accepted job addressed to this exact controller. */
export function pendingDaemonUpdateShutdown(
  home: string,
  controller: Pick<RuntimeControllerRecord, 'id' | 'epoch'> | null,
  pid = process.pid,
): HostUpdateCheckpointReference | null {
  if (!controller) return null;
  try {
    const operation = new HostUpdateOperations(home).read();
    if (
      !operation ||
      !['dispatching', 'applying'].includes(operation.phase) ||
      !operation.targets.some((target) => target.component === 'daemon')
    )
      return null;
    const job = readUpdateWorker(home, operation.id);
    const outgoing = job.outgoing;
    // Replacement controllers and runtime-default jobs never inherit this instruction.
    if (
      !outgoing ||
      outgoing.pid !== pid ||
      outgoing.controller.id !== controller.id ||
      outgoing.controller.epoch !== controller.epoch ||
      job.dispatch_id !== operation.dispatch_id ||
      job.preflight !== operation.approved ||
      job.dispatch_revision + (operation.phase === 'applying' ? 1 : 0) !== operation.revision
    )
      return null;
    return { operation_id: operation.id, dispatch_id: job.dispatch_id, preflight: job.preflight };
  } catch {
    // Missing or damaged evidence must not prevent ordinary shutdown. Without its
    // checkpoint the worker cannot prove continuity or proceed with activation.
    return null;
  }
}
