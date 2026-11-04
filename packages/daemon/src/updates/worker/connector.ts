import { homedir } from 'node:os';
import { join } from 'node:path';
import { realpath as resolvePath } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { HostUpdateWorker, HostStageReceipt } from '@puddle/shared';
import type { CompilationCommandRunner } from '../../compilation/process.js';
import {
  serviceIsStopped,
  startReplacementService,
  stopServiceForReplacement,
} from '../../host/supervision/replacement.js';
import { HostUpdateConnector, inspectConnectorManager } from '../preflight/connector.js';
import { requireExecutingUpdate, requireOutgoingController } from './operation.js';

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
  const operation = requireExecutingUpdate(home, job, 'verifying');
  const inspector = inspection(home, job, run);
  if (approved.state === 'absent') {
    if ((await inspector.inspect(operation)).state !== 'absent')
      throw new Error('Unexpected connector installation after update');
    return { state: 'absent' as const };
  }
  await startReplacementService(home, approved.service, run);
  const root = await resolvePath(join(home, 'bin/versions', stage.record.generation));
  const deadline = Date.now() + 30_000;
  for (;;) {
    const current = requireExecutingUpdate(home, job, 'verifying');
    const observed = await inspector.inspect(current);
    if (observed.state === 'running' && observed.identity && observed.service) {
      if (
        observed.identity.instance === approved.identity.instance ||
        observed.identity.release_path !== root ||
        observed.identity.version !== stage.record.version ||
        observed.service.definition_digest !== approved.service.definition_digest ||
        observed.service.name !== approved.service.name ||
        observed.service.kind !== approved.service.kind ||
        observed.service.domain !== approved.service.domain
      )
        throw new Error('Replacement connector does not match the selected generation and service');
      return { state: 'running' as const, identity: observed.identity, service: observed.service };
    }
    if (Date.now() >= deadline) throw new Error('Replacement connector is unconfirmed');
    await delay(100);
  }
}
