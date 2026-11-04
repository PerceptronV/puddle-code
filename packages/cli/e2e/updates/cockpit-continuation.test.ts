import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readUpdateRecoveryAttempts } from '@puddle/shared/node/host-control';
import { HostConnection } from '../../src/lib/auth/connection-authority.js';
import { CockpitHostUpdates } from '../../src/lib/host/updates/cockpit.js';
import { SshTransport } from '../../src/lib/transport/ssh.js';
import { continuationFixture } from '../helpers/update-continuation.js';
import { until } from '../helpers.js';
import { randomUUID } from 'node:crypto';

afterEach(() => vi.restoreAllMocks());

it('keeps the built local helper input open until its recorded continuation reply', async () => {
  const f = continuationFixture();
  const request_id = randomUUID();
  const input =
    JSON.stringify({
      t: 'host-update',
      request_id,
      command: {
        action: 'recover',
        strategy: 'continue',
        reference: { id: f.operation.id, revision: f.operation.revision },
      },
    }) + '\n';
  const result = await f.run('host-control.mjs', ['--participating-update'], input, true, true);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    t: 'host-update-result',
    request_id,
    result: { ok: true, recovery: { requested_revision: f.operation.revision } },
  });
  expect(readUpdateRecoveryAttempts(f.home, f.operation.id).attempts).toHaveLength(1);
  expect(readFileSync(join(f.home, 'dispatches.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
});

function fixture(protocol?: { major: number; minor: number }) {
  const f = continuationFixture(protocol);
  const transport = new SshTransport('user@fixture', { sshBinary: f.sshBinary, platform: 'win32' });
  vi.spyOn(transport, 'spawnEnv').mockReturnValue(f.env);
  const authority = new HostConnection(transport);
  authority.close(); // Deliberately disconnected; no automatic connection attempt.
  const control = new CockpitHostUpdates(transport, authority);
  const signal = new AbortController();
  const reference = { id: f.operation.id, revision: f.operation.revision };
  const request = (input = signal.signal) =>
    control.request({ action: 'continue-offline', reference }, () => !input.aborted, input);
  const checkpoint = (name: string) => until(() => existsSync(join(f.home, name)), Boolean, 10_000);
  return { ...f, transport, authority, control, signal, reference, request, checkpoint };
}

it('continues explicitly through the built SSH helper and observes exact repeated acceptance', async () => {
  const f = fixture();
  const status = await f.control.status(undefined, () => true, f.signal.signal);
  expect(status).toMatchObject({
    observation: 'recorded',
    capabilities: { offline_continuation: true },
  });
  const reply = await f.request();
  expect(reply).toMatchObject({
    ok: true,
    recovery: { requested_revision: f.reference.revision, consumed: false },
  });
  expect(await f.request()).toEqual(reply);
  const dispatches = readFileSync(join(f.home, 'dispatches.jsonl'), 'utf8').trim().split('\n');
  expect(dispatches).toHaveLength(1);
  expect(JSON.parse(dispatches[0]!)[4]).toBe('--participating-recovery');
  for (const hidden of ['private fixture diagnostic', 'node_path', f.home])
    expect(JSON.stringify(reply)).not.toContain(hidden);
});

it('refuses an older staged dispatcher without falling back to uncontrolled continuation', async () => {
  const f = fixture({ major: 25, minor: 16 });
  const status = await f.control.status(undefined, () => true, f.signal.signal);
  expect(status.capabilities.offline_continuation).toBeUndefined();
  expect(await f.request()).toMatchObject({ ok: false, code: 'unsupported' });
  expect(existsSync(join(f.home, 'before-dispatch'))).toBe(false);
  expect(readUpdateRecoveryAttempts(f.home, f.operation.id).attempts).toHaveLength(0);
});

it('does not open a recovery channel after revocation during helper staging', async () => {
  const f = fixture();
  const original = f.transport.exec.bind(f.transport);
  vi.spyOn(f.transport, 'exec').mockImplementationOnce(async (...args) => {
    const result = await original(...args);
    f.signal.abort();
    return result;
  });
  const open = vi.spyOn(f.transport, 'openChannel');
  await expect(f.request()).rejects.toThrow('authority expired');
  expect(open).not.toHaveBeenCalled();
  expect(existsSync(join(f.home, 'before-dispatch'))).toBe(false);
});

it('carries browser cancellation through the helper to the pending dispatcher', async () => {
  const f = fixture();
  writeFileSync(join(f.home, 'hold-before-dispatch'), 'hold');
  const pending = expect(f.request()).rejects.toThrow();
  await f.checkpoint('before-dispatch');
  f.signal.abort();
  await pending;
  await f.checkpoint('cancelled-dispatch');
  expect(readUpdateRecoveryAttempts(f.home, f.operation.id).attempts).toEqual([]);
  expect(existsSync(join(f.home, 'dispatches.jsonl'))).toBe(false);
});

it('retains accepted recovery after browser cancellation and never repeats it on inspection', async () => {
  const f = fixture();
  writeFileSync(join(f.home, 'hold-after-acceptance'), 'hold');
  const pending = expect(f.request()).rejects.toThrow();
  await f.checkpoint('after-acceptance');
  f.signal.abort();
  await pending;
  rmSync(join(f.home, 'hold-after-acceptance'));
  await f.checkpoint('finished-dispatch');
  const signal = new AbortController().signal;
  const status = await f.control.status(undefined, () => true, signal);
  expect(status.result).toMatchObject({
    ok: true,
    recovery: { requested_revision: f.reference.revision },
  });
  expect(await f.request(signal)).toEqual(status.result);
  expect(readFileSync(join(f.home, 'dispatches.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
});
