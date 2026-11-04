import type { HostUpdateOperation } from '@puddle/shared';
import type { CompilationCommandRunner } from '../../compilation/process.js';
import { requireCurrentAdoption } from '../verification/adoption.js';
import { verifyReplacementDaemon } from '../verification/daemon.js';
import { verifyUpdateSelection } from '../worker/selection.js';
import { readRecoveryActions } from './actions.js';
import { claimHostUpdateRecovery } from './claim.js';
import { retainStoppedUpdateRecovery } from './shutdown.js';

export async function claimUpdateContinuation(
  home: string,
  reference: Pick<HostUpdateOperation, 'id' | 'revision'>,
  authorised: () => boolean,
  run?: CompilationCommandRunner,
) {
  return retainUpdateContinuation(home, claimHostUpdateRecovery(home, reference, authorised), run);
}

/** A started replacement must prove adoption; never stop it to recreate the old hand-off. */
export async function retainUpdateContinuation(
  home: string,
  recovery: Pick<
    ReturnType<typeof claimHostUpdateRecovery>,
    'operation' | 'job' | 'check' | 'release' | 'releaseExecution'
  >,
  run?: CompilationCommandRunner,
) {
  try {
    const { operation, job } = recovery;
    const actions = readRecoveryActions(home, job, operation);
    const start = actions.actions.find(({ action }) => action === 'start-daemon');
    if (!start) throw new Error('Daemon continuation requires a daemon update');
    if (start.state === 'planned')
      return {
        ...(await retainStoppedUpdateRecovery(home, recovery, run)),
        mode: 'stopped' as const,
      };
    const { adoption } = await verifyReplacementDaemon(home, job, operation, run);
    recovery.check();
    let released = false;
    const check = () => {
      if (released) throw new Error('Running recovery claim is released');
      recovery.check();
      requireCurrentAdoption(home, adoption);
      operation.stages.forEach((stage) => verifyUpdateSelection(home, stage));
    };
    check();
    return {
      ...recovery,
      actions,
      mode: 'running' as const,
      check,
      // The running daemon retains its own controller throughout recovery.
      releaseController: () => {},
      release: () => {
        if (released) return;
        released = true;
        recovery.release();
      },
    };
  } catch (error) {
    recovery.release();
    throw error;
  }
}
