import { homedir } from 'node:os';
import type {
  HostUpdateWorker,
  HostUpdateOperation,
  HostUpdateActionJournal,
} from '@puddle/shared';
import type { CompilationCommandRunner } from '../../compilation/process.js';
import {
  requireUnchangedServiceDefinition,
  serviceIsStopped,
} from '../../host/supervision/replacement.js';
import { HostUpdateConnector, inspectConnectorManager } from '../preflight/connector.js';
import { inspectReplacementConnector } from '../verification/connector.js';

/** Observe an attempted start; only an unattempted, positively stopped service may be started. */
export async function inspectRecoveryConnector(
  home: string,
  job: HostUpdateWorker,
  operation: HostUpdateOperation,
  actions: HostUpdateActionJournal,
  run: CompilationCommandRunner,
) {
  const stage = operation.stages.find(({ record }) => record.component === 'daemon');
  if (!stage) throw new Error('Missing daemon recovery stage');
  if (await inspectReplacementConnector(home, job, operation, stage, run)) return 'ready' as const;
  if (actions.actions.find(({ action }) => action === 'start-connector')?.state !== 'planned')
    throw new Error('Attempted connector start has not established readiness');
  await requireStoppedRecoveryConnector(home, job, operation, run);
  return 'stopped' as const;
}

export async function requireStoppedRecoveryConnector(
  home: string,
  job: HostUpdateWorker,
  operation: HostUpdateOperation,
  run: CompilationCommandRunner,
) {
  const approved = job.connector;
  if (!approved) throw new Error('Missing approved connector inventory');
  if (approved.state === 'absent') {
    const observed = await new HostUpdateConnector(home, homedir(), {
      platform: job.kind === 'systemd' ? 'linux' : 'darwin',
      run,
    }).inspect(operation);
    if (observed.state !== 'absent' || observed.blockers.length)
      throw new Error('Connector installation changed during recovery');
    return;
  }
  await requireUnchangedServiceDefinition(home, approved.service, run);
  if (!(await serviceIsStopped(home, approved.service, run)))
    throw new Error('Outgoing connector is not stopped');
  let ended = false;
  try {
    process.kill(approved.identity.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    ended = true;
  }
  if (!ended || (await inspectConnectorManager(home)) !== null)
    throw new Error('Outgoing connector shutdown is unconfirmed');
}
