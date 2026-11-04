import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { HostUpdateReply } from '@puddle/shared';
import { acceptedCheckpointUpdate } from '../../../../daemon/test/helpers/update-checkpoint.js';
import { runUpdates } from '../../../src/cli/management/updates.js';

const mock = vi.hoisted(() => ({
  acquire: vi.fn(),
  open: vi.fn(),
  inspect: vi.fn(),
  continue: vi.fn(),
}));
vi.mock('../../../src/lib/auth/connection-authority.js', () => ({
  acquireAuthority: mock.acquire,
}));
vi.mock('../../../src/lib/transport/open.js', () => ({ openHostTransport: mock.open }));
vi.mock('../../../src/lib/auth/control-channel.js', () => ({
  inspectHostUpdate: mock.inspect,
  continueHostUpdate: mock.continue,
}));
const homes: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture(minor = 12) {
  const home = mkdtempSync(join(tmpdir(), 'puddle-update-cli-'));
  homes.push(home);
  const accepted = acceptedCheckpointUpdate(home);
  const worker = accepted.store.claimExecution(
    accepted.operation,
    accepted.operation.dispatch_id!,
    accepted.operation.preflight!,
  );
  const operation = worker.failed('Interrupted update');
  worker.release();
  const status: HostUpdateReply = { ok: true, operation };
  const authority = {
    generation: randomUUID(),
    state: 'ready',
    version: { protocol: { major: 25, minor } },
    hostUpdate: vi.fn().mockResolvedValueOnce(status),
    close: vi.fn(),
  };
  const transport = { label: 'fixture', dispose: vi.fn() };
  mock.open.mockResolvedValue(transport);
  mock.acquire.mockResolvedValue(authority);
  mock.inspect.mockResolvedValue(status);
  const command = {
    cmd: 'updates' as const,
    operation: operation.id,
    continue: true,
    cancel: false,
    recover: false,
  };
  const logger = { info: vi.fn(), warn: vi.fn() };
  return { operation, authority, transport, command, logger };
}

it('never dispatches through the offline helper after a lost live continuation reply', async () => {
  const f = fixture();
  f.authority.hostUpdate.mockRejectedValueOnce(new Error('Continuation reply lost'));
  await expect(runUpdates(f.command, f.logger)).rejects.toThrow('Continuation reply lost');
  expect(f.authority.hostUpdate).toHaveBeenLastCalledWith({
    action: 'recover',
    strategy: 'continue',
    reference: { id: f.operation.id, revision: f.operation.revision },
  });
  expect(mock.inspect).not.toHaveBeenCalled();
  expect(mock.continue).not.toHaveBeenCalled();
  expect(f.authority.close).toHaveBeenCalledOnce();
  expect(f.transport.dispose).toHaveBeenCalledOnce();
});

it('keeps an older live host on its existing status shape and refuses continuation', async () => {
  const f = fixture(11);
  await expect(runUpdates(f.command, f.logger)).rejects.toThrow('25.12');
  expect(f.authority.hostUpdate).toHaveBeenCalledExactlyOnceWith({
    action: 'status',
    id: f.operation.id,
  });
  expect(mock.continue).not.toHaveBeenCalled();
});

it('does not resubmit an offline continuation whose reply was lost', async () => {
  const f = fixture();
  mock.acquire.mockRejectedValueOnce(new Error('No daemon'));
  mock.continue.mockRejectedValueOnce(new Error('Helper reply lost'));
  await expect(runUpdates(f.command, f.logger)).rejects.toThrow('Helper reply lost');
  expect(mock.continue).toHaveBeenCalledExactlyOnceWith(f.transport, {
    id: f.operation.id,
    revision: f.operation.revision,
  });
  expect(mock.inspect).toHaveBeenCalledOnce();
  expect(f.authority.hostUpdate).not.toHaveBeenCalled();
  expect(f.transport.dispose).toHaveBeenCalledOnce();
});
