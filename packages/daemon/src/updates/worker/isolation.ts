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
  const replaced = [
    ...(daemon ? [daemon] : []),
    ...(job.connector?.state === 'running' ? [job.connector.service] : []),
  ];
  for (const service of replaced) {
    if (
      service.pid === pid ||
      service.name === job.name ||
      service.kind !== job.kind ||
      service.domain !== job.domain
    )
      throw new Error('Update worker is not independent of an outgoing host component');
  }
  const worker = await inspectRunningService(home, job, pid, run);
  const scopes = [...replaced, worker];
  for (let i = 0; i < scopes.length; i++) {
    for (const other of scopes.slice(i + 1)) {
      const service = scopes[i]!;
      if (service.name === other.name || service.pid === other.pid)
        throw new Error('Host components share a service process');
      if (service.kind !== 'systemd') continue;
      const parent = service.controlGroup!;
      const child = other.controlGroup!;
      if (parent === child || parent.startsWith(`${child}/`) || child.startsWith(`${parent}/`))
        throw new Error('Host components share a termination scope');
    }
  }
}
