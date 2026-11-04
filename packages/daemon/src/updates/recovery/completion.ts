import type { HostUpdateOperation } from '@puddle/shared';
import type { CompilationCommandRunner } from '../../compilation/process.js';
import { verifyHostUpdateCompletion } from '../verification/completion.js';
import { claimHostUpdateRecovery } from './claim.js';

/** Explicitly finish a completed installation; no component command is replayed. */
export async function recoverCompletedHostUpdate(
  home: string,
  reference: Pick<HostUpdateOperation, 'id' | 'revision'>,
  authorised: () => boolean,
  run?: CompilationCommandRunner,
): Promise<HostUpdateOperation> {
  const recovery = claimHostUpdateRecovery(home, reference, authorised);
  try {
    const verification = await verifyHostUpdateCompletion(
      home,
      recovery.job,
      recovery.operation,
      run,
    );
    return recovery.complete(verification);
  } finally {
    recovery.release();
  }
}
