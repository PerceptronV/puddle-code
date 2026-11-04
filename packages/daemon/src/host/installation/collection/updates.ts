import { join } from 'node:path';
import { hostUpdateOperationSchema, hostUpdateWorkerSchema } from '@puddle/shared';
import { readHostUpdateLedger, readUpdateRecoveryAttempts } from '@puddle/shared/node/host-control';
import { readHostUpdateCheckpoint } from '../../../updates/checkpoints/store.js';
import {
  boundedDirectories,
  boundedFiles,
  optionalRecord,
  ReleaseReferenceInventory,
} from './inventory.js';

export async function retainUpdateReleases(index: ReleaseReferenceInventory): Promise<void> {
  const ledger = readHostUpdateLedger(index.home);
  for (const operation of [ledger.current, ...ledger.history]) {
    if (!operation) continue;
    for (const { record } of operation.stages)
      index.add(join(index.versions, record.generation), `update:${operation.id}`);
  }
  for (const name of await boundedFiles(
    join(index.home, 'updates/checkpoints'),
    index.requireCurrent,
  )) {
    if (!name.endsWith('.json')) throw new Error('Unknown checkpoint prevents release collection');
    const id = hostUpdateOperationSchema.shape.id.parse(name.slice(0, -5));
    for (const owner of readHostUpdateCheckpoint(index.home, id).owners)
      index.add(owner.release_path, `checkpoint:${id}`);
  }
  // Jobs outlive the bounded operation history. Keep their pinned executables too:
  // a trimmed history entry alone does not prove that a registered job cannot run.
  for (const id of await boundedDirectories(
    join(index.home, 'updates/jobs'),
    index.requireCurrent,
  )) {
    hostUpdateOperationSchema.shape.id.parse(id);
    const value = optionalRecord(join(index.home, 'updates/jobs', id, 'worker.json'), 32 * 1024);
    if (!value) throw new Error('Unknown update worker prevents release collection');
    const worker = hostUpdateWorkerSchema.parse(value);
    if (worker.operation_id !== id) throw new Error('Update worker identity changed');
    index.add(worker.release_path, `worker:${id}`);
    for (const path of [worker.node_path, worker.entry_path, worker.installer_path])
      index.executable(path, `worker:${id}`);
    for (const { job } of readUpdateRecoveryAttempts(index.home, id).attempts) {
      index.add(job.service.release_path, `recovery:${job.id}`);
      for (const path of [
        job.service.node_path,
        job.service.entry_path,
        job.service.installer_path,
      ])
        index.executable(path, `recovery:${job.id}`);
      for (const owner of job.daemon_restart?.owners ?? [])
        index.add(owner.release_path, `recovery-runtime:${job.id}`);
    }
  }
}
