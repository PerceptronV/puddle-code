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
export class HostUpdateActionWriter {
  constructor(
    private readonly path: string,
    private readonly initial: HostUpdateActionJournal,
    private readonly requireCurrent: (action: HostUpdateAction) => void,
    private readonly write: typeof atomicPrivateJson = atomicPrivateJson,
  ) {
    try {
      readPrivateJson(path, 4096);
      throw new Error('Update actions were already recorded');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.save(initial);
  }

  private read() {
    const record = hostUpdateActionsSchema.parse(readPrivateJson(this.path, 4096));
    const identity = (value: HostUpdateActionJournal) => ({
      ...value,
      actions: value.actions.map(({ action }) => action),
    });
    if (JSON.stringify(identity(record)) !== JSON.stringify(identity(this.initial)))
      throw new Error('Update actions do not match the executing worker');
    return record;
  }

  async run(action: HostUpdateAction, execute: () => Promise<void>): Promise<void> {
    this.requireCurrent(action);
    const journal = this.read();
    const next = journal.actions.find((item) => item.state !== 'finished');
    if (next?.action !== action || next.state !== 'planned')
      throw new Error('Update action was already attempted or is out of order');
    next.state = 'started';
    this.save(journal); // Durable intent precedes the first possible external mutation.
    await execute();
    this.requireCurrent(action);
    const current = this.read();
    if (JSON.stringify(current) !== JSON.stringify(journal))
      throw new Error('Update actions changed during execution');
    next.state = 'finished';
    this.save(journal); // A failed acknowledgement leaves started, never planned.
  }

  private save(record: HostUpdateActionJournal) {
    this.write(this.path, hostUpdateActionsSchema.parse(record), {
      syncDirectory: true,
    });
  }
}

/** Ordinary worker composition; recovery uses the same one-shot journal writer. */
export class HostUpdateActions extends HostUpdateActionWriter {
  constructor(
    home: string,
    job: HostUpdateWorker,
    write: typeof atomicPrivateJson = atomicPrivateJson,
  ) {
    const operation = requireExecutingUpdate(home, job, 'applying');
    super(
      file(home, job),
      hostUpdateActionsSchema.parse({
        format: 1,
        operation_id: operation.id,
        dispatch_id: operation.dispatch_id,
        worker_id: operation.worker_id,
        preflight: operation.approved,
        actions: plan(operation).map((action) => ({ action, state: 'planned' })),
      }),
      (action) => {
        requireExecutingUpdate(home, job, action.startsWith('start-') ? 'verifying' : 'applying');
      },
      write,
    );
  }
}
