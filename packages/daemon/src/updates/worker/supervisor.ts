import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  hostUpdateOperationSchema,
  hostUpdateWorkerSchema,
  type HostUpdateOperation,
  type HostUpdateWorker,
} from '@puddle/shared';
import {
  atomicPrivateJson,
  digest,
  privateDirectory,
  readPrivateJson,
  syncPrivateDirectory,
} from '@puddle/shared/node';
import type { CompilationCommandRunner } from '../../compilation/process.js';
import {
  dispatchService,
  independentServiceDefinition,
  validServicePath,
  writeServiceDefinition,
} from '../../host/services.js';
import { acquireHostClaim } from '../../security/claims.js';
import { HostUpdateOperations } from '../operations/store.js';

export function updateWorkerDirectory(home: string, id: string): string {
  hostUpdateOperationSchema.shape.id.parse(id);
  return join(home, 'updates', 'jobs', id);
}

export function readUpdateWorker(home: string, id: string): HostUpdateWorker {
  const record = hostUpdateWorkerSchema.parse(
    readPrivateJson(join(updateWorkerDirectory(home, id), 'worker.json'), 32 * 1024),
  );
  if (record.operation_id !== id) throw new Error('Update worker identity mismatch');
  return record;
}

/** Pinned files must remain in one immutable installation generation. */
function executables(home: string, release: string) {
  validServicePath(release);
  const versions = realpathSync(join(home, 'bin', 'versions'));
  const root = realpathSync(release);
  if (dirname(root) !== versions) throw new Error('Update worker is outside installed releases');
  const file = (relative: string, access: number) => {
    const expected = join(root, relative);
    const path = realpathSync(expected);
    if (path !== expected || !statSync(path).isFile())
      throw new Error('Update worker file is not pinned to its release');
    accessSync(path, access);
    return path;
  };
  return {
    release_path: root,
    node_path: file('bin/node', constants.X_OK),
    entry_path: file('daemon/host-update.mjs', constants.R_OK),
    installer_path: file('daemon/install.sh', constants.R_OK),
  };
}

/** Consume the operation before dispatch; a lost acknowledgement is observation-only. */
export async function startUpdateWorker(
  home: string,
  reference: Pick<HostUpdateOperation, 'id' | 'revision'>,
  options: {
    kind: HostUpdateWorker['kind'];
    releasePath: string;
    uid?: number;
    run?: CompilationCommandRunner;
  },
): Promise<HostUpdateWorker> {
  const store = new HostUpdateOperations(home);
  validServicePath(home);
  const directory = updateWorkerDirectory(home, reference.id);
  const claim = acquireHostClaim(home, `host-update-dispatch:${reference.id}`);
  try {
    try {
      // A new choice of worker/kind cannot re-dispatch an accepted operation.
      return readUpdateWorker(home, reference.id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const candidate = store.read(reference.id);
    if (candidate?.targets.length !== 1 || candidate.targets[0]?.component !== 'runtime')
      throw new Error(
        'Daemon updates require quiescence and adoption verification before dispatch',
      );
    const paths = executables(home, options.releasePath);
    const uid = options.uid ?? process.getuid?.();
    if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0)
      throw new Error('Host update supervision requires a host user');
    privateDirectory(join(home, 'updates', 'jobs'));
    privateDirectory(directory);
    syncPrivateDirectory(join(home, 'updates'));
    syncPrivateDirectory(join(home, 'updates', 'jobs'));
    const operation = store.dispatch(reference);
    const key = digest(realpathSync(home)).slice(0, 8);
    const record = hostUpdateWorkerSchema.parse({
      format: 1,
      operation_id: operation.id,
      dispatch_id: operation.dispatch_id,
      dispatch_revision: operation.revision,
      preflight: operation.preflight,
      kind: options.kind,
      name:
        options.kind === 'systemd'
          ? `puddle-update-${key}-${operation.id}.service`
          : `dev.puddle.update.${key}.${operation.id}`,
      domain: options.kind === 'launchd' ? `gui/${uid}` : null,
      ...paths,
      state: 'dispatching',
    });
    const definition = join(directory, record.kind === 'systemd' ? record.name : 'update.plist');
    writeServiceDefinition(
      definition,
      independentServiceDefinition({
        home,
        kind: record.kind,
        name: record.name,
        description: `Puddle host update ${operation.id}`,
        args: [record.node_path, record.entry_path, '--home', home, '--operation', operation.id],
        timeoutSeconds: 180,
      }),
    );
    atomicPrivateJson(join(directory, 'worker.json'), record, { syncDirectory: true });
    await dispatchService(home, record, definition, options.run);
    record.state = 'dispatched';
    atomicPrivateJson(join(directory, 'worker.json'), record, { syncDirectory: true });
    return record;
  } finally {
    claim.release();
  }
}
