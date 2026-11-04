import type { HostUpdateWorker } from '@puddle/shared';
import type { CompilationCommandRunner } from '../../compilation/process.js';
import { inspectRunningService } from '../../host/supervision/inspection.js';

/** The executable's PID must belong to the recorded independent worker service. */
export async function verifyUpdateWorkerIsolation(
  home: string,
  job: HostUpdateWorker,
  run?: CompilationCommandRunner,
  pid = process.pid,
): Promise<void> {
  const daemon = job.daemon_service;
  if (!daemon) return;
  if (
    daemon.pid === pid ||
    daemon.name === job.name ||
    daemon.kind !== job.kind ||
    daemon.domain !== job.domain
  )
    throw new Error('Update worker is not independent of the outgoing daemon');
  const worker = await inspectRunningService(home, job, pid, run);
  if (daemon.kind === 'systemd') {
    const parent = daemon.controlGroup!;
    const child = worker.controlGroup!;
    if (parent === child || parent.startsWith(`${child}/`) || child.startsWith(`${parent}/`))
      throw new Error('Update worker shares the daemon termination scope');
  }
}
