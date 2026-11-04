import { setTimeout as delay } from 'node:timers/promises';
import {
  compatibleRuntimeProtocol,
  hostUpdateWorkerSchema,
  type HostUpdateWorker,
  type HostUpdateAdoption,
} from '@puddle/shared';
import { digest } from '@puddle/shared/node';
import { runCompilationCommand, type CompilationCommandRunner } from '../../compilation/process.js';
import { startReplacementService } from '../../host/supervision/replacement.js';
import { HostUpdateOperations } from '../operations/store.js';
import { readStageCapabilities } from '../preflight/candidate.js';
import { stopDaemonForUpdate } from './daemon/stop.js';
import { selectUpdateStage, verifyUpdateSelection } from './selection.js';
import { verifyHostUpdateAdoption } from './verify-adoption.js';

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
  if (daemon && (!job.daemon_service || !job.outgoing))
    throw new Error('Daemon updates require approved service and controller evidence');
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
    if (daemon) {
      handoff = await stopDaemonForUpdate(home, job, execute);
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
    let adoption: HostUpdateAdoption | undefined;
    if (daemon) {
      await startReplacementService(home, job.daemon_service!, execute);
      const deadline = Date.now() + 30_000;
      for (;;) {
        try {
          adoption = await verifyHostUpdateAdoption(home, verifying);
          break;
        } catch (error) {
          if (Date.now() >= deadline) throw error;
          // Retry observation only; never repeat stop, activation, startup or input.
          await delay(100);
        }
      }
    }
    const selected = pending.stages.map((stage) => verifyUpdateSelection(home, stage));
    worker.complete(digest(JSON.stringify({ selected, adoption })));
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
