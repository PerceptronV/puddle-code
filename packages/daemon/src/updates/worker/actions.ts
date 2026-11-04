import { join } from 'node:path';
import {
  hostUpdateActionsSchema,
  type HostUpdateAction,
  type HostUpdateActionJournal,
  type HostUpdateOperation,
  type HostUpdateWorker,
} from '@puddle/shared';
import { atomicPrivateJson, readPrivateJson } from '@puddle/shared/node';
import { updateWorkerDirectory } from './supervisor.js';
import { requireExecutingUpdate } from './operation.js';

const file = (home: string, job: HostUpdateWorker) =>
  join(updateWorkerDirectory(home, job.operation_id), 'actions.json');

function plan(operation: HostUpdateOperation): HostUpdateAction[] {
  const daemon = operation.targets.some(({ component }) => component === 'daemon');
  return [
    ...(daemon ? (['stop-connector', 'stop-daemon'] as const) : []),
    ...operation.stages.map(({ record }): HostUpdateAction => `select-${record.component}`),
    ...(daemon ? (['start-daemon', 'start-connector'] as const) : []),
  ];
}

/** Missing or malformed evidence never means a command is safe to repeat. */
export function readUpdateActions(
  home: string,
  job: HostUpdateWorker,
  operation: HostUpdateOperation,
): HostUpdateActionJournal {
  const record = hostUpdateActionsSchema.parse(readPrivateJson(file(home, job), 4096));
  if (
    record.operation_id !== operation.id ||
    record.dispatch_id !== operation.dispatch_id ||
    record.worker_id !== operation.worker_id ||
    record.preflight !== operation.approved ||
    job.operation_id !== operation.id ||
    job.dispatch_id !== operation.dispatch_id ||
    job.preflight !== operation.approved ||
    JSON.stringify(record.actions.map(({ action }) => action)) !== JSON.stringify(plan(operation))
  )
    throw new Error('Update actions do not match the accepted worker');
  return record;
}

/** Used only while holding the worker execution claim; never resumes an existing journal. */
export class HostUpdateActions {
  constructor(
    private readonly home: string,
    private readonly job: HostUpdateWorker,
    private readonly write: typeof atomicPrivateJson = atomicPrivateJson,
  ) {
    const operation = requireExecutingUpdate(home, job, 'applying');
    try {
      readPrivateJson(file(home, job), 4096);
      throw new Error('Update actions were already recorded');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.save(
      hostUpdateActionsSchema.parse({
        format: 1,
        operation_id: operation.id,
        dispatch_id: operation.dispatch_id,
        worker_id: operation.worker_id,
        preflight: operation.approved,
        actions: plan(operation).map((action) => ({ action, state: 'planned' })),
      }),
    );
  }

  async run(action: HostUpdateAction, execute: () => Promise<void>): Promise<void> {
    const phase = action.startsWith('start-') ? 'verifying' : 'applying';
    const operation = requireExecutingUpdate(this.home, this.job, phase);
    const journal = readUpdateActions(this.home, this.job, operation);
    const next = journal.actions.find((item) => item.state !== 'finished');
    if (next?.action !== action || next.state !== 'planned')
      throw new Error('Update action was already attempted or is out of order');
    next.state = 'started';
    this.save(journal); // Durable intent precedes the first possible external mutation.
    await execute();
    requireExecutingUpdate(this.home, this.job, phase);
    const current = readUpdateActions(this.home, this.job, operation);
    if (JSON.stringify(current) !== JSON.stringify(journal))
      throw new Error('Update actions changed during execution');
    next.state = 'finished';
    this.save(journal); // A failed acknowledgement leaves started, never planned.
  }

  private save(record: HostUpdateActionJournal) {
    this.write(file(this.home, this.job), hostUpdateActionsSchema.parse(record), {
      syncDirectory: true,
    });
  }
}
