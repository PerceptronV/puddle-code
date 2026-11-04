import {
  compatibleRuntimeProtocol,
  hostUpdateWorkerSchema,
  type HostUpdateWorker,
} from '@puddle/shared';
import { runCompilationCommand, type CompilationCommandRunner } from '../../compilation/process.js';
import { startReplacementService } from '../../host/supervision/replacement.js';
import { HostUpdateOperations } from '../operations/store.js';
import { readStageCapabilities } from '../preflight/candidate.js';
import { stopConnectorForUpdate, startConnectorAfterUpdate } from './connector.js';
import { stopDaemonForUpdate } from './daemon/stop.js';
import { selectUpdateStage, verifyUpdateSelection } from './selection.js';
import { awaitHostUpdateCompletion } from '../verification/completion.js';
import { recordUpdateWorkerLifetime } from './lifetime.js';
import { HostUpdateActions } from './actions.js';
import { requireCheckpointCompatibility } from '../checkpoints/compatibility.js';

/** One consumed worker transaction; uncertainty always retains its operation for inspection. */
export async function executeHostUpdate(
  home: string,
  input: HostUpdateWorker,
  run: CompilationCommandRunner = runCompilationCommand,
): Promise<void> {
  const job = hostUpdateWorkerSchema.parse(input);
  const execute: CompilationCommandRunner = (command) => run({ ...command, detached: false });
  const store = new HostUpdateOperations(home);
  const pending = store.read(job.operation_id);
  if (!pending) throw new Error('Missing accepted update operation');
  const daemon = pending.stages.find((stage) => stage.record.component === 'daemon');
  const runtime = pending.stages.find((stage) => stage.record.component === 'runtime');
  if (daemon && (!job.daemon_service || !job.outgoing || !job.connector))
    throw new Error('Daemon updates require approved service, connector and controller evidence');
  if (runtime && !compatibleRuntimeProtocol(runtime.record.protocol))
    throw new Error('Unsupported runtime update stage');
  const candidate = daemon ? await readStageCapabilities(home, daemon) : null;
  const worker = store.claimExecution(
    { id: job.operation_id, revision: job.dispatch_revision },
    job.dispatch_id,
    job.preflight,
  );
  let handoff: Awaited<ReturnType<typeof stopDaemonForUpdate>> | undefined;
  try {
    await recordUpdateWorkerLifetime(home, job, worker.operation, execute);
    const actions = new HostUpdateActions(home, job);
    if (daemon) {
      if (candidate!.database_schema_version === undefined)
        throw new Error('Candidate database support is unknown');
      await actions.run('stop-connector', async () => {
        await stopConnectorForUpdate(home, job, execute);
      });
      await actions.run('stop-daemon', async () => {
        handoff = await stopDaemonForUpdate(home, job, execute);
      });
      requireCheckpointCompatibility(candidate!, handoff!.checkpoint);
    }
    // Each selector is atomic. A failure between components retains the exact partial
    // result for recovery; never silently undo a selection or replay its installer.
    for (const stage of pending.stages) {
      await actions.run(`select-${stage.record.component}`, async () => {
        await selectUpdateStage(home, job, stage, execute);
        verifyUpdateSelection(home, stage);
      });
    }
    const verifying = worker.verifying();
    handoff?.release();
    handoff = undefined;
    if (daemon) {
      await actions.run('start-daemon', async () => {
        await startReplacementService(home, job.daemon_service!, execute);
      });
      await actions.run('start-connector', async () => {
        await startConnectorAfterUpdate(home, job, daemon, execute);
      });
    }
    const verification = await awaitHostUpdateCompletion(home, job, verifying, execute);
    worker.complete(verification);
  } catch (error) {
    try {
      worker.failed('Host activation or verification requires inspection');
    } catch {
      /* Keep the earlier durable phase if storage is unavailable. */
    }
    throw error;
  } finally {
    handoff?.release();
    worker.release();
  }
}
