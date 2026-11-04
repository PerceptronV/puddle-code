import {
  hostUpdateWorkerSchema,
  type HostUpdateAdoption,
  type HostUpdateOperation,
  type HostUpdateWorker,
} from '@puddle/shared';
import { setTimeout as delay } from 'node:timers/promises';
import { digest } from '@puddle/shared/node';
import type { CompilationCommandRunner } from '../../compilation/process.js';
import { inspectRunningService } from '../../host/supervision/inspection.js';
import { prepareServiceReplacement } from '../../host/supervision/replacement.js';
import { verifyUpdateSelection } from '../worker/selection.js';
import { requireCurrentAdoption, verifyHostUpdateAdoption } from './adoption.js';
import { inspectReplacementConnector } from './connector.js';
import { requireVerificationOperation } from './operation.js';

/** Retry observations only while replacement services establish readiness. */
export async function awaitHostUpdateCompletion(
  home: string,
  job: HostUpdateWorker,
  operation: HostUpdateOperation,
  run?: CompilationCommandRunner,
): Promise<string> {
  const daemon = operation.targets.some(({ component }) => component === 'daemon');
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      return await verifyHostUpdateCompletion(home, job, operation, run);
    } catch (error) {
      if (!daemon || Date.now() >= deadline) throw error;
      await delay(100);
    }
  }
}

/** Shared by execution and recovery: observe completion without repeating component mutations. */
export async function verifyHostUpdateCompletion(
  home: string,
  input: HostUpdateWorker,
  operation: HostUpdateOperation,
  run?: CompilationCommandRunner,
): Promise<string> {
  const job = hostUpdateWorkerSchema.parse(input);
  requireVerificationOperation(home, operation, job);
  // Reject partial selection before asking a daemon for adoption evidence.
  operation.stages.forEach((stage) => verifyUpdateSelection(home, stage));
  const daemon = operation.stages.find((stage) => stage.record.component === 'daemon');
  let adoption: HostUpdateAdoption | undefined;
  let connector: NonNullable<Awaited<ReturnType<typeof inspectReplacementConnector>>> | undefined;
  let service: Awaited<ReturnType<typeof prepareServiceReplacement>> | undefined;
  if (daemon) {
    if (!job.daemon_service || !job.outgoing || !job.connector)
      throw new Error('Missing approved daemon replacement evidence');
    adoption = await verifyHostUpdateAdoption(home, operation);
    service = await prepareServiceReplacement(
      home,
      await inspectRunningService(home, job.daemon_service, adoption.daemon.pid, run),
      { definitionPath: job.daemon_service.definition_path ?? undefined, run },
    );
    if (service.definition_digest !== job.daemon_service.definition_digest)
      throw new Error('Replacement daemon configuration changed');
    const observed = await inspectReplacementConnector(home, job, operation, daemon, run);
    if (!observed) throw new Error('Replacement connector is unconfirmed');
    connector = observed;
  }
  // Files and the operation may have changed while the authority/service probes yielded.
  const selected = operation.stages.map((stage) => verifyUpdateSelection(home, stage));
  requireVerificationOperation(home, operation, job);
  if (adoption) requireCurrentAdoption(home, adoption);
  return digest(JSON.stringify({ selected, adoption, connector, service }));
}
