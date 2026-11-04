import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import type { HostUpdateWorker, HostStageReceipt } from '@puddle/shared';
import type { CompilationCommandRunner } from '../../compilation/process.js';
import {
  startReplacementService,
  stopServiceForReplacement,
} from '../../host/supervision/replacement.js';
import { serviceIsStopped } from '../../host/supervision/stopped.js';
import { HostUpdateConnector, inspectConnectorManager } from '../preflight/connector.js';
import { requireExecutingUpdate, requireOutgoingController } from './operation.js';
import { inspectReplacementConnector } from '../verification/connector.js';

function inspection(home: string, job: HostUpdateWorker, run?: CompilationCommandRunner) {
  return new HostUpdateConnector(home, homedir(), {
    platform: job.kind === 'systemd' ? 'linux' : 'darwin',
    run,
  });
}

/** Check the approved connector before stopping either host component. Never infer approval from absence. */
export async function stopConnectorForUpdate(
  home: string,
  job: HostUpdateWorker,
  run?: CompilationCommandRunner,
) {
  const approved = job.connector;
  if (!approved) throw new Error('Missing approved connector inventory');
  const operation = requireExecutingUpdate(home, job, 'applying');
  const observed = await inspection(home, job, run).inspect(operation);
  if (approved.state === 'absent') {
    if (observed.state !== 'absent')
      throw new Error('Connector installation changed before update');
    return;
  }
  if (
    observed.state !== 'running' ||
    JSON.stringify(observed.identity) !== JSON.stringify(approved.identity) ||
    JSON.stringify(observed.service) !== JSON.stringify(approved.service)
  )
    throw new Error('Outgoing connector changed before update');
  await stopServiceForReplacement(
    home,
    approved.service,
    () => {
      requireExecutingUpdate(home, job, 'applying');
      requireOutgoingController(home, job);
    },
    run,
  );
  const deadline = Date.now() + 30_000;
  for (;;) {
    requireExecutingUpdate(home, job, 'applying');
    if (await serviceIsStopped(home, approved.service, run)) {
      let ended = false;
      try {
        process.kill(approved.identity.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        ended = true;
      }
      if (ended && (await inspectConnectorManager(home)) === null) return;
    }
    if (Date.now() >= deadline) throw new Error('Outgoing connector shutdown is unconfirmed');
    await delay(100);
  }
}

/** Start once, then observe the exact selected connector without replaying the mutation. */
export async function startConnectorAfterUpdate(
  home: string,
  job: HostUpdateWorker,
  stage: HostStageReceipt,
  run?: CompilationCommandRunner,
) {
  const approved = job.connector;
  if (!approved) throw new Error('Missing approved connector inventory');
  requireExecutingUpdate(home, job, 'verifying');
  if (approved.state === 'running') await startReplacementService(home, approved.service, run);
  const deadline = Date.now() + 30_000;
  for (;;) {
    const current = requireExecutingUpdate(home, job, 'verifying');
    const observed = await inspectReplacementConnector(home, job, current, stage, run);
    if (observed) return observed;
    if (Date.now() >= deadline) throw new Error('Replacement connector is unconfirmed');
    await delay(100);
  }
}
