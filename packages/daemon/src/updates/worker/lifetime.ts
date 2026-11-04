import { join } from 'node:path';
import {
  hostUpdateWorkerLifetimeSchema,
  type HostUpdateOperation,
  type HostUpdateWorker,
} from '@puddle/shared';
import { atomicPrivateJson, readPrivateJson } from '@puddle/shared/node';
import { runCompilationCommand, type CompilationCommandRunner } from '../../compilation/process.js';
import { HostUpdateOperations } from '../operations/store.js';
import { updateWorkerDirectory } from './supervisor.js';
import { verifyUpdateWorkerIsolation } from './isolation.js';

const file = (home: string, job: HostUpdateWorker) =>
  join(updateWorkerDirectory(home, job.operation_id), 'lifetime.json');

/** A free execution lock alone cannot prove that an installer's child processes ended. */
export async function recordUpdateWorkerLifetime(
  home: string,
  job: HostUpdateWorker,
  operation: HostUpdateOperation,
  run: CompilationCommandRunner = runCompilationCommand,
  pid = process.pid,
): Promise<void> {
  const requireClaim = () => {
    if (
      operation.phase !== 'applying' ||
      !operation.worker_id ||
      operation.id !== job.operation_id ||
      operation.dispatch_id !== job.dispatch_id ||
      operation.approved !== job.preflight ||
      JSON.stringify(new HostUpdateOperations(home).read(operation.id)) !==
        JSON.stringify(operation)
    )
      throw new Error('Worker lifetime does not match the executing update');
  };
  requireClaim();
  await verifyUpdateWorkerIsolation(home, job, run, pid);
  const observed = await run({
    file: '/bin/ps',
    args: ['-o', 'pgid=', '-p', String(pid)],
    cwd: home,
    detached: false,
    timeoutMs: 5000,
    maxOutputBytes: 1024,
  });
  if (observed.exitCode !== 0 || observed.stdout.trim() !== String(pid))
    throw new Error('Update worker does not lead its process group');
  requireClaim();
  const record = hostUpdateWorkerLifetimeSchema.parse({
    format: 1,
    operation_id: operation.id,
    dispatch_id: operation.dispatch_id,
    worker_id: operation.worker_id,
    preflight: operation.approved,
    process_group: pid,
  });
  const path = file(home, job);
  try {
    readPrivateJson(path, 4096);
    throw new Error('Update worker lifetime was already recorded');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  atomicPrivateJson(path, record, { syncDirectory: true });
}

/** Probe only: never signal a recorded PID/group, which may have been reused. */
export function requireEndedUpdateWorker(
  home: string,
  job: HostUpdateWorker,
  operation: HostUpdateOperation,
): void {
  const record = hostUpdateWorkerLifetimeSchema.parse(readPrivateJson(file(home, job), 4096));
  if (
    !operation.worker_id ||
    record.operation_id !== operation.id ||
    record.dispatch_id !== operation.dispatch_id ||
    record.worker_id !== operation.worker_id ||
    record.preflight !== operation.approved ||
    job.operation_id !== operation.id ||
    job.dispatch_id !== operation.dispatch_id ||
    job.preflight !== operation.approved
  )
    throw new Error('Worker lifetime does not match recovery');
  try {
    process.kill(-record.process_group, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw error;
  }
  throw new Error('Update worker or its commands are still running');
}
