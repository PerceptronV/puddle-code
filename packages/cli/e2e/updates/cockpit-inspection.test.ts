import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { HostConnection } from '../../src/lib/auth/connection-authority.js';
import { CockpitHostUpdates } from '../../src/lib/host/updates/cockpit.js';
import { SshTransport } from '../../src/lib/transport/ssh.js';
import { offlineUpdateFixture } from '../helpers/host-updates.js';

afterEach(() => vi.restoreAllMocks());

it('reads recorded cockpit status through the built SSH helper without connecting to a daemon', async () => {
  const f = offlineUpdateFixture();
  const before = readFileSync(f.ledger);
  // No multiplexing directory is needed by the fake SSH executable. Each subprocess
  // receives the existing fixture's isolated, allowlisted client/target environment.
  const transport = new SshTransport('user@fixture', {
    sshBinary: f.sshBinary,
    platform: 'win32',
  });
  vi.spyOn(transport, 'spawnEnv').mockReturnValue(f.env);
  const channel = vi.spyOn(transport, 'openChannel');
  const exec = vi.spyOn(transport, 'exec');
  const authority = new HostConnection(transport);
  authority.close();
  const control = new CockpitHostUpdates(transport, authority);
  const signal = new AbortController().signal;
  const status = await control.status(f.operation.id, () => true, signal);
  expect(status).toMatchObject({
    availability: 'unavailable',
    observation: 'recorded',
    result: {
      ok: true,
      operation: { id: f.operation.id, revision: f.operation.revision, phase: 'dispatching' },
    },
  });
  const output = JSON.stringify(status);
  for (const hidden of [f.home, 'dispatch_id', 'worker_id', 'tree_sha256', 'archive_sha256'])
    expect(output).not.toContain(hidden);
  expect(exec).toHaveBeenCalledTimes(2); // Stage the existing helper, then read once.
  expect(exec.mock.calls[1]![0]).toMatch(/ --updates$/);
  expect(await control.status(f.operation.id, () => true, signal)).toEqual(status);
  expect(exec).toHaveBeenCalledTimes(3); // The staged helper is reused.
  expect(channel).not.toHaveBeenCalled();
  expect(readFileSync(f.ledger)).toEqual(before);
  for (const name of ['puddle.db', 'runtime.json', 'token', 'supervisor'])
    expect(existsSync(join(f.home, name))).toBe(false);
});
