import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  hostUpdateActionsSchema,
  hostUpdateRecoveryJobSchema,
  type HostUpdateRecoveryJob,
  type HostUpdateWorker,
  type HostUpdateOperation,
} from '@puddle/shared';
import { digest } from '@puddle/shared/node';
import {
  runCompilationCommand,
  type CompilationCommandRunner,
} from '../../../compilation/process.js';
import {
  requireUnchangedServiceDefinition,
  serviceIsStopped,
  startReplacementService,
} from '../../../host/supervision/replacement.js';
import { HostUpdateOperations } from '../../operations/store.js';
import { HostUpdateConnector, inspectConnectorManager } from '../../preflight/connector.js';
import { requireVerificationOperation } from '../../verification/operation.js';
import { awaitHostUpdateCompletion } from '../../verification/completion.js';
import { HostUpdateActionWriter, readUpdateActions } from '../../worker/actions.js';
import {
  inspectUpdateWorkerProcessGroup,
  requireEndedUpdateWorker,
} from '../../worker/lifetime.js';
import { selectUpdateStage, verifyUpdateSelection } from '../../worker/selection.js';
import { readUpdateWorker } from '../../worker/supervisor.js';
import { retainStoppedUpdateRecovery } from '../shutdown.js';
import {
  HostUpdateRecoveryAttempts,
  readUpdateRecoveryAttempts,
  requireEndedUpdateRecoveryWorkers,
  updateRecoveryDirectory,
} from './records.js';

async function requireStoppedConnector(
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

/** One accepted continuation after shutdown. Never repeat an attempted selection or service start. */
export async function executeStoppedUpdateRecovery(
  home: string,
  input: HostUpdateRecoveryJob,
  run: CompilationCommandRunner = runCompilationCommand,
): Promise<void> {
  const job = hostUpdateRecoveryJobSchema.parse(input);
  const pending = readUpdateRecoveryAttempts(home, job.operation_id).attempts.find(
    ({ job: recorded }) => recorded.id === job.id,
  );
  if (!pending || pending.execution || JSON.stringify(pending.job) !== JSON.stringify(job))
    throw new Error('Recovery dispatch is missing, changed or already consumed');
  const records = new HostUpdateRecoveryAttempts(home, job.operation_id);
  const store = new HostUpdateOperations(home);
  const worker = store.claimRecovery({ id: job.operation_id, revision: job.revision });
  const operation = worker.operation;
  let handoff: Awaited<ReturnType<typeof retainStoppedUpdateRecovery>> | undefined;
  let current: { id: string; execution: string; processGroup: number } | undefined;
  const execute: CompilationCommandRunner = (command) => run({ ...command, detached: false });
  try {
    const original = readUpdateWorker(home, operation.id);
    const history = readUpdateRecoveryAttempts(home, operation.id).attempts;
    const accepted = history.find(({ job: recorded }) => recorded.id === job.id);
    if (
      !accepted ||
      accepted.execution ||
      JSON.stringify(accepted.job) !== JSON.stringify(job) ||
      history.some((attempt) => attempt.execution)
    )
      throw new Error('Recovery dispatch is missing, changed or already consumed');
    if (job.original_worker_digest !== digest(JSON.stringify(original)))
      throw new Error('Original update worker changed');
    const originalActions = readUpdateActions(home, original, operation);
    if (
      job.actions_digest !== digest(JSON.stringify(originalActions)) ||
      originalActions.actions.find(({ action }) => action === 'start-daemon')?.state !== 'planned'
    )
      throw new Error('Recovery step evidence changed or includes an attempted daemon start');
    const check = () => {
      requireVerificationOperation(home, operation, original);
      requireEndedUpdateWorker(home, original, operation);
      requireEndedUpdateRecoveryWorkers(home, operation, current);
      const attempt = readUpdateRecoveryAttempts(home, operation.id).attempts.find(
        ({ job: recorded }) => recorded.id === job.id,
      );
      if (
        !attempt ||
        JSON.stringify(attempt.job) !== JSON.stringify(job) ||
        (current ? attempt.execution?.id !== current.execution : attempt.execution !== null)
      )
        throw new Error('Recovery execution identity changed');
    };
    check();
    // Reuse the original component evidence, with this recovery service's own pinned executable.
    const processGroup = await inspectUpdateWorkerProcessGroup(
      home,
      { ...original, ...job.service },
      execute,
    );
    check();
    const consumed = records.claim(job, processGroup, check);
    current = { id: job.id, execution: consumed.execution!.id, processGroup };
    check();
    const actions = new HostUpdateActionWriter(
      join(updateRecoveryDirectory(home, operation.id), job.id, 'actions.json'),
      hostUpdateActionsSchema.parse({
        ...originalActions,
        worker_id: current.execution,
        actions: originalActions.actions.map(({ action }) => ({ action, state: 'planned' })),
      }),
      check,
    );
    handoff = await retainStoppedUpdateRecovery(
      home,
      {
        operation,
        job: original,
        check,
        release: worker.release,
        releaseExecution: worker.release,
      },
      execute,
    );
    await actions.run('stop-connector', () =>
      requireStoppedConnector(home, original, operation, execute),
    );
    await actions.run('stop-daemon', async () => {
      handoff!.check();
    });
    for (const stage of operation.stages) {
      const action = `select-${stage.record.component}` as const;
      await actions.run(action, async () => {
        if (originalActions.actions.find((item) => item.action === action)?.state === 'planned')
          await selectUpdateStage(home, { ...original, ...job.service }, stage, execute);
        verifyUpdateSelection(home, stage);
      });
    }
    handoff.releaseController();
    await actions.run('start-daemon', () =>
      startReplacementService(home, original.daemon_service!, execute),
    );
    await actions.run('start-connector', async () => {
      if (original.connector?.state === 'running')
        await startReplacementService(home, original.connector.service, execute);
    });
    const verification = await awaitHostUpdateCompletion(home, original, operation, execute);
    check();
    worker.complete(verification);
  } finally {
    try {
      handoff?.release();
    } finally {
      worker.release();
    }
  }
}
