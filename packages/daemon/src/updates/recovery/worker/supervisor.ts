import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { hostUpdateRecoveryJobSchema, type HostUpdateOperation } from '@puddle/shared';
import { digest, privateDirectory, syncPrivateDirectory } from '@puddle/shared/node';
import type { CompilationCommandRunner } from '../../../compilation/process.js';
import {
  dispatchService,
  independentServiceDefinition,
  writeServiceDefinition,
} from '../../../host/services.js';
import { updateWorkerExecutables } from '../../worker/supervisor.js';
import { claimStoppedHostUpdateRecovery } from '../shutdown.js';
import {
  HostUpdateRecoveryAttempts,
  readUpdateRecoveryAttempts,
  updateRecoveryDirectory,
} from './records.js';

/** Explicit stopped-daemon recovery only. Recorded attempts are observed, never re-dispatched. */
export async function startStoppedUpdateRecoveryWorker(
  home: string,
  reference: Pick<HostUpdateOperation, 'id' | 'revision'>,
  options: {
    releasePath: string;
    authorised: () => boolean;
    uid?: number;
    run?: CompilationCommandRunner;
  },
) {
  if (!options.authorised()) throw new Error('Host recovery authority expired');
  const history = readUpdateRecoveryAttempts(home, reference.id).attempts;
  const previous = history.find(({ job }) => job.requested_revision === reference.revision);
  if (previous) return previous.job;
  if (history.some(({ execution }) => execution))
    throw new Error(
      'An executed recovery attempt requires completion inspection before another dispatch',
    );
  const recovery = await claimStoppedHostUpdateRecovery(
    home,
    reference,
    options.authorised,
    options.run,
  );
  try {
    const { operation, job: original, actions } = recovery;
    if (actions.actions.find(({ action }) => action === 'start-daemon')?.state !== 'planned')
      throw new Error('Recovery after an attempted daemon start requires replacement inspection');
    const paths = updateWorkerExecutables(home, options.releasePath);
    const uid = options.uid ?? process.getuid?.();
    if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0)
      throw new Error('Host recovery supervision requires a host user');
    const domain = original.kind === 'launchd' ? `gui/${uid}` : null;
    if (original.domain !== domain)
      throw new Error('Recovery belongs to another supervisor domain');
    const id = randomUUID();
    const key = digest(realpathSync(home)).slice(0, 8);
    const job = hostUpdateRecoveryJobSchema.parse({
      format: 1,
      id,
      operation_id: operation.id,
      requested_revision: reference.revision,
      revision: operation.revision,
      original_dispatch_id: original.dispatch_id,
      original_worker_id: operation.worker_id,
      preflight: operation.approved,
      original_worker_digest: digest(JSON.stringify(original)),
      actions_digest: digest(JSON.stringify(actions)),
      service: {
        ...paths,
        kind: original.kind,
        domain,
        name:
          original.kind === 'systemd'
            ? `puddle-recovery-${key}-${id}.service`
            : `dev.puddle.recovery.${key}.${id}`,
      },
    });
    const attempts = new HostUpdateRecoveryAttempts(home, operation.id);
    const directory = join(updateRecoveryDirectory(home, operation.id), id);
    privateDirectory(directory);
    syncPrivateDirectory(updateRecoveryDirectory(home, operation.id));
    const definition = join(
      directory,
      job.service.kind === 'systemd' ? job.service.name : 'recovery.plist',
    );
    writeServiceDefinition(
      definition,
      independentServiceDefinition({
        home,
        kind: job.service.kind,
        name: job.service.name,
        description: `Puddle host recovery ${operation.id}`,
        args: [
          job.service.node_path,
          job.service.entry_path,
          '--home',
          home,
          '--operation',
          operation.id,
          '--recovery',
          id,
        ],
        timeoutSeconds: 180,
      }),
    );
    attempts.append(job, recovery.check);
    // Release these only after durable acceptance. Keep dispatch exclusion until
    // the supervisor reply, while the independent worker can acquire execution.
    recovery.releaseController();
    recovery.releaseExecution();
    await dispatchService(home, job.service, definition, options.run);
    return job;
  } finally {
    recovery.release();
  }
}
