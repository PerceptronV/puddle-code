import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { digest } from '@puddle/shared/node';
import { verifyUpdateWorkerIsolation } from '../../../src/updates/worker/isolation.js';
import { acceptedCheckpointUpdate, checkpointWorker } from '../../helpers/update-checkpoint.js';
import { systemdObservation } from '../../helpers/host-supervision.js';
import { randomUUID } from 'node:crypto';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

it('requires the executing worker PID in a distinct service outside the daemon cgroup', async () => {
  const home = mkdtempSync(join(tmpdir(), 'puddle-update-isolation-'));
  homes.push(home);
  const job = checkpointWorker(home, acceptedCheckpointUpdate(home), {
    pid: 123,
    controller: { id: randomUUID(), epoch: 1 },
  });
  job.daemon_service = {
    kind: 'systemd',
    name: 'puddled.service',
    domain: null,
    pid: 123,
    invocation: 'a'.repeat(32),
    controlGroup: '/user.slice/app.slice/puddled.service',
    definition_path: null,
    definition_digest: digest('definition'),
  };
  const run = async () => ({ exitCode: 0, stderr: '', stdout: systemdObservation(456, job.name) });
  await expect(verifyUpdateWorkerIsolation(home, job, run, 456)).resolves.toBeUndefined();
  await expect(verifyUpdateWorkerIsolation(home, job, run, 123)).rejects.toThrow('independent');
  await expect(verifyUpdateWorkerIsolation(home, job, run, 789)).rejects.toThrow('running daemon');
  await expect(
    verifyUpdateWorkerIsolation(home, { ...job, name: 'puddled.service' }, run, 456),
  ).rejects.toThrow('independent');
  const nested = async () => ({
    exitCode: 0,
    stderr: '',
    stdout: systemdObservation(456, job.name).replace(
      `/user.slice/user-501.slice/user@501.service/app.slice/${job.name}`,
      `${job.daemon_service!.controlGroup}/${job.name}`,
    ),
  });
  await expect(verifyUpdateWorkerIsolation(home, job, nested, 456)).rejects.toThrow(
    'termination scope',
  );
  job.connector = {
    state: 'running',
    identity: {
      instance: randomUUID(),
      pid: 789,
      ready: true,
      version: '0.4.0',
      application: { major: 25, minor: 9 },
      remote: 4,
      node_path: '/unused/bin/node',
      entry_path: '/unused/daemon/connector.mjs',
      release_path: '/unused',
    },
    service: {
      ...job.daemon_service!,
      component: 'connector',
      pid: 789,
      name: 'puddle-connector.service',
      controlGroup: '/user.slice/puddle-connector.service',
    },
  };
  await expect(verifyUpdateWorkerIsolation(home, job, run, 456)).resolves.toBeUndefined();
  job.connector.service.controlGroup = `${job.daemon_service.controlGroup}/puddle-connector.service`;
  await expect(verifyUpdateWorkerIsolation(home, job, run, 456)).rejects.toThrow(
    'termination scope',
  );
  job.connector.service.controlGroup = `/user.slice/user-501.slice/user@501.service/app.slice/${job.name}/puddle-connector.service`;
  await expect(verifyUpdateWorkerIsolation(home, job, run, 456)).rejects.toThrow(
    'termination scope',
  );
});
