import { homedir } from 'node:os';
import { digest } from '@puddle/shared/node';
import type {
  HostUpdateWorker,
  HostUpdateOperation,
  HostUpdateActionJournal,
} from '@puddle/shared';
import type { CompilationCommandRunner } from '../../compilation/process.js';
import { requireUnchangedServiceDefinition } from '../../host/supervision/replacement.js';
import { serviceIsStopped } from '../../host/supervision/stopped.js';
import { HostUpdateConnector, inspectConnectorManager } from '../preflight/connector.js';
import { inspectReplacementConnector } from '../verification/connector.js';
import { verifyUpdateSelection } from '../worker/selection.js';

/** An attempted start needs separately accepted restart evidence unless already healthy. */
export async function inspectRecoveryConnector(
  home: string,
  job: HostUpdateWorker,
  operation: HostUpdateOperation,
  actions: HostUpdateActionJournal,
  run: CompilationCommandRunner,
  restart?: string,
) {
  const stage = operation.stages.find(({ record }) => record.component === 'daemon');
  if (!stage) throw new Error('Missing daemon recovery stage');
  if (await inspectReplacementConnector(home, job, operation, stage, run)) return 'ready' as const;
  if (actions.actions.find(({ action }) => action === 'start-connector')?.state !== 'planned') {
    if (restart && (await inspectConnectorRestartEvidence(home, job, operation, run)) === restart)
      return 'restart' as const;
    throw new Error('Attempted connector start has not established readiness');
  }
  if (restart) throw new Error('Connector restart does not match retained start intent');
  await requireStoppedRecoveryConnector(home, job, operation, run);
  return 'stopped' as const;
}

/** Read-only evidence for a fresh explicit attempt; lack of readiness alone never proves loss. */
export async function inspectConnectorRecoveryRestart(
  home: string,
  job: HostUpdateWorker,
  operation: HostUpdateOperation,
  actions: HostUpdateActionJournal,
  run?: CompilationCommandRunner,
) {
  const start = actions.actions.find(({ action }) => action === 'start-connector');
  if (!start) throw new Error('Missing connector recovery step');
  if (start.state === 'planned') return undefined;
  const stage = operation.stages.find(({ record }) => record.component === 'daemon');
  if (!stage) throw new Error('Missing daemon recovery stage');
  if (await inspectReplacementConnector(home, job, operation, stage, run)) return undefined;
  return inspectConnectorRestartEvidence(home, job, operation, run);
}

async function inspectConnectorRestartEvidence(
  home: string,
  job: HostUpdateWorker,
  operation: HostUpdateOperation,
  run?: CompilationCommandRunner,
) {
  if (job.connector?.state !== 'running') throw new Error('Missing approved connector service');
  const stage = operation.stages.find(({ record }) => record.component === 'daemon');
  if (!stage) throw new Error('Missing daemon recovery stage');
  await requireStoppedRecoveryConnector(home, job, operation, run, true);
  const selected = verifyUpdateSelection(home, stage);
  return digest(JSON.stringify({ connector: job.connector, selected }));
}

export async function requireStoppedRecoveryConnector(
  home: string,
  job: HostUpdateWorker,
  operation: HostUpdateOperation,
  run?: CompilationCommandRunner,
  allowFailed = false,
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
  if (!(await serviceIsStopped(home, approved.service, run, allowFailed)))
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
  if (allowFailed && !(await serviceIsStopped(home, approved.service, run, true)))
    throw new Error('Connector service changed during recovery');
}
