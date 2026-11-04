import { setTimeout as delay } from 'node:timers/promises';
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
import { verifyHostUpdateCompletion } from '../verification/completion.js';
import { recordUpdateWorkerLifetime } from './lifetime.js';

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
    if (daemon) {
      if (candidate!.database_schema_version === undefined)
        throw new Error('Candidate database support is unknown');
      await stopConnectorForUpdate(home, job, execute);
      handoff = await stopDaemonForUpdate(home, job, execute);
      if (
        candidate!.database_schema_version === undefined ||
        candidate!.database_schema_version < handoff.checkpoint.daemon.schema_version
      )
        throw new Error('Candidate cannot open the checkpointed application database');
      if (
        handoff.checkpoint.owners.some(
          (owner) => !candidate!.supported_runtime_majors.includes(owner.protocol.major),
        )
      )
        throw new Error('Candidate cannot adopt a checkpointed runtime');
    }
    // Each selector is atomic. A failure between components retains the exact partial
    // result for recovery; never silently undo a selection or replay its installer.
    for (const stage of pending.stages) {
      await selectUpdateStage(home, job, stage, execute);
      verifyUpdateSelection(home, stage);
    }
    const verifying = worker.verifying();
    handoff?.release();
    handoff = undefined;
    if (daemon) {
      await startReplacementService(home, job.daemon_service!, execute);
      await startConnectorAfterUpdate(home, job, daemon, execute);
    }
    const deadline = Date.now() + 30_000;
    let verification: string;
    for (;;) {
      try {
        verification = await verifyHostUpdateCompletion(home, job, verifying, execute);
        break;
      } catch (error) {
        if (!daemon || Date.now() >= deadline) throw error;
        // Retry observation only; never repeat stop, activation, startup or input.
        await delay(100);
      }
    }
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
