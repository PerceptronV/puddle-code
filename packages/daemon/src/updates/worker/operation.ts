import type { HostUpdateWorker } from '@puddle/shared';
import { HostUpdateOperations } from '../operations/store.js';
import { readRuntimeController } from '../../runtime/ownership/storage.js';

export function requireOutgoingController(home: string, job: HostUpdateWorker): void {
  const controller = readRuntimeController(home);
  if (
    !job.outgoing ||
    !controller.active ||
    controller.id !== job.outgoing.controller.id ||
    controller.epoch !== job.outgoing.controller.epoch
  )
    throw new Error('Outgoing daemon controller changed before stop');
}

/** Recheck durable consumption before a component mutation or replacement observation. */
export function requireExecutingUpdate(
  home: string,
  job: HostUpdateWorker,
  phase: 'applying' | 'verifying',
) {
  const operation = new HostUpdateOperations(home).read(job.operation_id);
  if (
    operation?.phase !== phase ||
    !operation.worker_id ||
    operation.revision !== job.dispatch_revision + (phase === 'applying' ? 1 : 2) ||
    operation.dispatch_id !== job.dispatch_id ||
    operation.approved !== job.preflight ||
    !operation.targets.some((target) => target.component === 'daemon')
  )
    throw new Error('Component replacement does not match an executing update');
  return operation;
}
