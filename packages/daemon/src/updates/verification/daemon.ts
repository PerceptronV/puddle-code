import type { HostUpdateOperation, HostUpdateWorker } from '@puddle/shared';
import type { CompilationCommandRunner } from '../../compilation/process.js';
import { inspectRunningService } from '../../host/supervision/inspection.js';
import { prepareServiceReplacement } from '../../host/supervision/replacement.js';
import { verifyUpdateSelection } from '../worker/selection.js';
import { requireCurrentAdoption, verifyHostUpdateAdoption } from './adoption.js';
import { requireVerificationOperation } from './operation.js';

/** Fresh daemon adoption and exact service configuration, independent of connector readiness. */
export async function verifyReplacementDaemon(
  home: string,
  job: HostUpdateWorker,
  operation: HostUpdateOperation,
  run?: CompilationCommandRunner,
) {
  requireVerificationOperation(home, operation, job);
  if (!job.daemon_service || !job.outgoing || !job.connector)
    throw new Error('Missing approved daemon replacement evidence');
  operation.stages.forEach((stage) => verifyUpdateSelection(home, stage));
  const adoption = await verifyHostUpdateAdoption(home, operation);
  const service = await prepareServiceReplacement(
    home,
    await inspectRunningService(home, job.daemon_service, adoption.daemon.pid, run),
    { definitionPath: job.daemon_service.definition_path ?? undefined, run },
  );
  if (service.definition_digest !== job.daemon_service.definition_digest)
    throw new Error('Replacement daemon configuration changed');
  operation.stages.forEach((stage) => verifyUpdateSelection(home, stage));
  requireVerificationOperation(home, operation, job);
  requireCurrentAdoption(home, adoption);
  return { adoption, service };
}
