import type { HostUpdateCheckpointReference, HostUpdateWorker } from '@puddle/shared';
import { hostUpdateWorkerSchema } from '@puddle/shared';
import { atomicPrivateJson, digest, privateDirectory } from '@puddle/shared/node';
import { join } from 'node:path';
import { HostUpdateOperations } from '../../src/updates/operations/store.js';
import { updateWorkerDirectory } from '../../src/updates/worker/supervisor.js';

export function acceptedCheckpointUpdate(
  home: string,
  component: 'daemon' | 'runtime' = 'daemon',
  protocol = { major: 25, minor: 7 },
) {
  const store = new HostUpdateOperations(home);
  let operation = store.begin([{ component, version: '0.4.0' }]).operation;
  // This is operation-state evidence only; no installer or worker is dispatched.
  const record = {
    format: 1 as const,
    component,
    generation: '0.4.0~ABC123',
    version: '0.4.0',
    protocol,
    archive_sha256: digest('archive'),
    tree_sha256: digest('tree'),
    checksum_verified: true,
  };
  operation = store.staged(operation, { record, digest: digest(`${JSON.stringify(record)}\n`) });
  operation = store.preflight(operation, digest('inspected impact'));
  operation = store.approve(operation, operation.preflight!);
  operation = store.dispatch(operation);
  const reference: HostUpdateCheckpointReference = {
    operation_id: operation.id,
    dispatch_id: operation.dispatch_id!,
    preflight: operation.preflight!,
  };
  return { store, operation, reference };
}

/** Accepted private metadata only; no installed worker or supervisor is invoked. */
export function checkpointWorker(
  home: string,
  accepted: ReturnType<typeof acceptedCheckpointUpdate>,
  outgoing: NonNullable<HostUpdateWorker['outgoing']>,
): HostUpdateWorker {
  const { operation, reference } = accepted;
  const job = hostUpdateWorkerSchema.parse({
    format: 1,
    ...reference,
    dispatch_revision: operation.revision,
    kind: 'systemd',
    name: 'puddle-update-fixture.service',
    domain: null,
    release_path: '/unused/release',
    node_path: '/unused/release/bin/node',
    entry_path: '/unused/release/daemon/host-update.mjs',
    installer_path: '/unused/release/daemon/install.sh',
    state: 'dispatched',
    outgoing,
  });
  privateDirectory(join(home, 'updates', 'jobs'));
  const directory = updateWorkerDirectory(home, operation.id);
  privateDirectory(directory);
  atomicPrivateJson(join(directory, 'worker.json'), job);
  return job;
}
