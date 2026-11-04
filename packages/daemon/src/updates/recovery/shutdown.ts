import type { HostUpdateOperation } from '@puddle/shared';
import type { CompilationCommandRunner } from '../../compilation/process.js';
import { readStageCapabilities } from '../preflight/candidate.js';
import { requireCheckpointCompatibility } from '../checkpoints/compatibility.js';
import { claimStoppedDaemonUpdate } from '../verification/shutdown.js';
import { readRecoveryActions } from './actions.js';
import { claimHostUpdateRecovery } from './claim.js';

/** Recover the original hand-off without stopping a service or opening application storage. */
export async function claimStoppedHostUpdateRecovery(
  home: string,
  reference: Pick<HostUpdateOperation, 'id' | 'revision'>,
  authorised: () => boolean,
  run?: CompilationCommandRunner,
) {
  return retainStoppedUpdateRecovery(
    home,
    claimHostUpdateRecovery(home, reference, authorised),
    run,
  );
}

/** The independent recovery worker already holds execution and its accepted authority. */
export async function retainStoppedUpdateRecovery(
  home: string,
  recovery: Pick<
    ReturnType<typeof claimHostUpdateRecovery>,
    'operation' | 'job' | 'check' | 'release' | 'releaseExecution'
  >,
  run?: CompilationCommandRunner,
) {
  let handoff: Awaited<ReturnType<typeof claimStoppedDaemonUpdate>> = null;
  try {
    const { operation, job } = recovery;
    const actions = readRecoveryActions(home, job, operation);
    const stop = actions.actions.find(({ action }) => action === 'stop-daemon');
    if (!stop || stop.state === 'planned')
      throw new Error('The original daemon shutdown was never attempted');
    const stage = operation.stages.find(({ record }) => record.component === 'daemon');
    if (!stage) throw new Error('Missing daemon recovery stage');
    const candidate = await readStageCapabilities(home, stage);
    recovery.check();
    handoff = await claimStoppedDaemonUpdate(home, job, recovery.check, run);
    if (!handoff)
      throw new Error('Daemon shutdown checkpoint or controller release is unconfirmed');
    requireCheckpointCompatibility(candidate, handoff.checkpoint);
    recovery.check();
    let released = false;
    let controllerReleased = false;
    const releaseController = () => {
      if (controllerReleased) return;
      controllerReleased = true;
      handoff!.release();
    };
    return {
      operation,
      job,
      actions,
      checkpoint: handoff.checkpoint,
      checkpointDigest: handoff.digest,
      check: () => {
        if (released || controllerReleased) throw new Error('Stopped recovery claim is released');
        recovery.check();
      },
      releaseController,
      releaseExecution: recovery.releaseExecution,
      release: () => {
        if (released) return;
        released = true;
        try {
          releaseController();
        } finally {
          recovery.release();
        }
      },
    };
  } catch (error) {
    try {
      handoff?.release();
    } finally {
      recovery.release();
    }
    throw error;
  }
}
