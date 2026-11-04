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
import { HostActionWriter } from '../../host/installation/action-writer.js';

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
export class HostUpdateActionWriter extends HostActionWriter<
  HostUpdateAction,
  HostUpdateActionJournal
> {
  constructor(
    path: string,
    initial: HostUpdateActionJournal,
    requireCurrent: (action: HostUpdateAction) => void,
    write: typeof atomicPrivateJson = atomicPrivateJson,
  ) {
    super({
      path,
      initial,
      requireCurrent,
      write,
      parse: hostUpdateActionsSchema.parse,
      maxBytes: 4096,
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
