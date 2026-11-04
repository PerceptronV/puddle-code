import { setTimeout as delay } from 'node:timers/promises';
import { hostUpdateWorkerSchema, type HostUpdateWorker } from '@puddle/shared';
import type { CompilationCommandRunner } from '../../../compilation/process.js';
import {
  stopServiceForReplacement,
  serviceIsStopped,
} from '../../../host/supervision/replacement.js';
import { readRuntimeController } from '../../../runtime/ownership/storage.js';
import { acquireHostClaim, HostClaimBusy } from '../../../security/claims.js';
import { readHostUpdateCheckpointEvidence } from '../../checkpoints/store.js';
import { HostUpdateOperations } from '../../operations/store.js';

/** Stop once, then prove both supervisor shutdown and exact durable ownership hand-off. */
export async function stopDaemonForUpdate(
  home: string,
  input: HostUpdateWorker,
  run?: CompilationCommandRunner,
) {
  const job = hostUpdateWorkerSchema.parse(input);
  const service = job.daemon_service;
  const outgoing = job.outgoing;
  if (!service || !outgoing || service.pid !== outgoing.pid)
    throw new Error('Missing outgoing daemon service evidence');
  const requireExecuting = () => {
    const operation = new HostUpdateOperations(home).read(job.operation_id);
    if (
      operation?.phase !== 'applying' ||
      !operation.worker_id ||
      operation.revision !== job.dispatch_revision + 1 ||
      operation.dispatch_id !== job.dispatch_id ||
      operation.approved !== job.preflight ||
      !operation.targets.some((target) => target.component === 'daemon')
    )
      throw new Error('Daemon stop does not match an executing update');
  };
  requireExecuting();
  await stopServiceForReplacement(
    home,
    service,
    () => {
      requireExecuting();
      const controller = readRuntimeController(home);
      if (
        !controller.active ||
        controller.id !== outgoing.controller.id ||
        controller.epoch !== outgoing.controller.epoch
      )
        throw new Error('Outgoing daemon controller changed before stop');
      try {
        readHostUpdateCheckpointEvidence(home, job.operation_id);
        throw new Error('Daemon update already has a shutdown checkpoint');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    },
    run,
  );
  const deadline = Date.now() + 30_000;
  for (;;) {
    requireExecuting();
    if (await serviceIsStopped(home, service, run)) {
      try {
        const evidence = readHostUpdateCheckpointEvidence(home, job.operation_id);
        const { checkpoint } = evidence;
        if (
          checkpoint.dispatch_id !== job.dispatch_id ||
          checkpoint.preflight !== job.preflight ||
          checkpoint.daemon.pid !== outgoing.pid ||
          checkpoint.daemon.controller.id !== outgoing.controller.id ||
          checkpoint.daemon.controller.epoch !== outgoing.controller.epoch ||
          checkpoint.owners.some(
            (owner) => owner.state === 'prepared' || owner.state === 'interrupted',
          )
        )
          throw new Error('Outgoing daemon did not prove runtime continuity');
        // Do not mint another controller epoch. Keep new controllers out until selector
        // verification is complete; the caller releases this claim before service start.
        const claim = acquireHostClaim(home, 'daemon-controller');
        let retain = false;
        try {
          const controller = readRuntimeController(home);
          if (
            controller.id !== outgoing.controller.id ||
            controller.epoch !== outgoing.controller.epoch
          )
            throw new Error('Outgoing daemon controller was replaced');
          if (!controller.active) {
            retain = true;
            return { ...evidence, release: () => claim.release() };
          }
        } finally {
          if (!retain) claim.release();
        }
      } catch (error) {
        // launchd can remove registration before asynchronous signal drainage ends.
        // Observe that same shutdown, never send another stop or infer a lost owner.
        if (!(error instanceof HostClaimBusy) && (error as NodeJS.ErrnoException).code !== 'ENOENT')
          throw error;
      }
    }
    if (Date.now() >= deadline)
      throw new Error('Daemon shutdown checkpoint or controller release is unconfirmed');
    await delay(100);
  }
}
