import { setTimeout as delay } from 'node:timers/promises';
import { hostUpdateWorkerSchema, type HostUpdateWorker } from '@puddle/shared';
import type { CompilationCommandRunner } from '../../../compilation/process.js';
import { stopServiceForReplacement } from '../../../host/supervision/replacement.js';
import { claimStoppedDaemonUpdate } from '../../verification/shutdown.js';
import { readHostUpdateCheckpointEvidence } from '../../checkpoints/store.js';
import { requireExecutingUpdate, requireOutgoingController } from '../operation.js';

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
  const requireExecuting = () => requireExecutingUpdate(home, job, 'applying');
  requireExecuting();
  await stopServiceForReplacement(
    home,
    service,
    () => {
      requireExecuting();
      requireOutgoingController(home, job);
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
    const handoff = await claimStoppedDaemonUpdate(home, job, requireExecuting, run);
    if (handoff) return handoff;
    if (Date.now() >= deadline)
      throw new Error('Daemon shutdown checkpoint or controller release is unconfirmed');
    await delay(100);
  }
}
