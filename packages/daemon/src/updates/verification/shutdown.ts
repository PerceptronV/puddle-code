import { hostUpdateWorkerSchema, type HostUpdateWorker } from '@puddle/shared';
import type { CompilationCommandRunner } from '../../compilation/process.js';
import { requireUnchangedServiceDefinition } from '../../host/supervision/replacement.js';
import { serviceIsStopped } from '../../host/supervision/stopped.js';
import { readRuntimeController } from '../../runtime/ownership/storage.js';
import { acquireHostClaim, HostClaimBusy } from '../../security/claims.js';
import { readHostUpdateCheckpointEvidence } from '../checkpoints/store.js';

export function readDaemonUpdateCheckpoint(home: string, job: HostUpdateWorker) {
  const outgoing = job.outgoing;
  const evidence = readHostUpdateCheckpointEvidence(home, job.operation_id);
  const { checkpoint } = evidence;
  if (
    !outgoing ||
    checkpoint.dispatch_id !== job.dispatch_id ||
    checkpoint.preflight !== job.preflight ||
    checkpoint.daemon.pid !== outgoing.pid ||
    checkpoint.daemon.controller.id !== outgoing.controller.id ||
    checkpoint.daemon.controller.epoch !== outgoing.controller.epoch ||
    checkpoint.owners.some((owner) => owner.state === 'prepared' || owner.state === 'interrupted')
  )
    throw new Error('Outgoing daemon did not prove runtime continuity');
  return evidence;
}

/** Observe an existing shutdown, holding off new controllers without minting another epoch. */
export async function claimStoppedDaemonUpdate(
  home: string,
  input: HostUpdateWorker,
  requireCurrent: () => void,
  run?: CompilationCommandRunner,
) {
  const job = hostUpdateWorkerSchema.parse(input);
  const service = job.daemon_service;
  const outgoing = job.outgoing;
  if (!service || !outgoing || service.pid !== outgoing.pid)
    throw new Error('Missing outgoing daemon service evidence');
  requireCurrent();
  await requireUnchangedServiceDefinition(home, service, run);
  requireCurrent();
  const stopped = await serviceIsStopped(home, service, run);
  requireCurrent();
  if (!stopped) return null;
  try {
    const evidence = readDaemonUpdateCheckpoint(home, job);
    const claim = acquireHostClaim(home, 'daemon-controller');
    let retain = false;
    try {
      requireCurrent();
      const controller = readRuntimeController(home);
      if (
        controller.id !== outgoing.controller.id ||
        controller.epoch !== outgoing.controller.epoch
      )
        throw new Error('Outgoing daemon controller was replaced');
      if (controller.active) return null;
      retain = true;
      return { ...evidence, release: () => claim.release() };
    } finally {
      if (!retain) claim.release();
    }
  } catch (error) {
    // launchd can remove registration before signal drainage finishes. Only
    // observation may be retried; absence never authorises another stop.
    if (error instanceof HostClaimBusy || (error as NodeJS.ErrnoException).code === 'ENOENT')
      return null;
    throw error;
  }
}
