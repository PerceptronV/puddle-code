import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  hostUpdateOperationSchema,
  type HostUpdateCommand,
  type HostUpdateReply,
  type HostStageReceipt,
} from '@puddle/shared';
import type { HostControlClient } from '@puddle/shared/node/host-control';
import { prepareHostUpdate } from '../../../src/lib/installation/host/updates.js';
import type { Transport } from '../../../src/lib/transport/transport.js';

function fixture() {
  let operation = hostUpdateOperationSchema.parse({
    format: 1,
    id: randomUUID(),
    revision: 1,
    created_at: 1,
    updated_at: 1,
    phase: 'downloading',
    targets: [{ component: 'runtime', version: '0.4.0' }],
    stages: [],
    preflight: null,
    approved: null,
    dispatch_id: null,
    worker_id: null,
    verification: null,
    message: null,
  });
  const receipt: HostStageReceipt = {
    digest: 'a'.repeat(64),
    record: {
      format: 1,
      component: 'runtime',
      generation: '0.4.0~ABC123',
      version: '0.4.0',
      protocol: { major: 1, minor: 0 },
      archive_sha256: 'b'.repeat(64),
      tree_sha256: 'c'.repeat(64),
      checksum_verified: true,
    },
  };
  let created = true;
  const request = vi.fn(async (command: HostUpdateCommand): Promise<HostUpdateReply> => {
    if (command.action === 'begin') return { ok: true, operation, created };
    if (command.action === 'stage') {
      operation = { ...operation, phase: 'staged', revision: 2, stages: [command.receipt] };
      return { ok: true, operation };
    }
    return { ok: true, operation };
  });
  const authority: Pick<HostControlClient, 'generation' | 'state' | 'hostUpdate'> = {
    generation: randomUUID(),
    state: 'ready',
    hostUpdate: request,
  };
  // No transport operation runs in this orchestration test: the stage helper is injected.
  const transport = { kind: 'ssh', label: 'test-host' } as Transport;
  const stage = vi.fn(async () => receipt);
  return {
    authority,
    transport,
    stage,
    request,
    targets: operation.targets,
    receipt,
    coalesce: () => {
      created = false;
    },
  };
}

it('stages through the existing selected transport only for the winning caller', async () => {
  const f = fixture();
  const operation = await prepareHostUpdate(
    f.transport,
    f.authority,
    f.targets,
    { tarball: '/archive.tar.gz' },
    f.stage,
  );
  expect(operation.phase).toBe('staged');
  expect(f.stage).toHaveBeenCalledExactlyOnceWith(f.transport, 'runtime', {
    tarball: '/archive.tar.gz',
    version: '0.4.0',
  });
  expect(f.request.mock.calls.map(([command]) => command.action)).toEqual(['begin', 'stage']);
  f.coalesce();
  expect(await prepareHostUpdate(f.transport, f.authority, f.targets, {}, f.stage)).toEqual(
    operation,
  );
  expect(f.stage).toHaveBeenCalledOnce();
});

it('never records a stage under a replacement control generation or retries its download', async () => {
  const f = fixture();
  f.stage.mockImplementationOnce(async () => {
    f.authority.generation = randomUUID();
    return f.receipt;
  });
  await expect(prepareHostUpdate(f.transport, f.authority, f.targets, {}, f.stage)).rejects.toThrow(
    'connection changed',
  );
  expect(f.request.mock.calls.map(([command]) => command.action)).toEqual(['begin']);
  expect(f.stage).toHaveBeenCalledOnce();
});

it('records a staging failure only through the still-participating original connection', async () => {
  const f = fixture();
  f.stage.mockRejectedValueOnce(new Error('checksum failed'));
  await expect(prepareHostUpdate(f.transport, f.authority, f.targets, {}, f.stage)).rejects.toThrow(
    'checksum failed',
  );
  expect(f.request.mock.calls.map(([command]) => command.action)).toEqual(['begin', 'cancel']);
  expect(f.request.mock.calls[1]![0]).toMatchObject({ reason: 'staging_failed' });
});

it('does not repeat an uncertain stage acknowledgement or compensate by cancelling it', async () => {
  const f = fixture();
  f.request.mockImplementationOnce(async () => ({
    ok: true,
    operation: hostUpdateOperationSchema.parse({
      format: 1,
      id: randomUUID(),
      revision: 1,
      created_at: 1,
      updated_at: 1,
      phase: 'downloading',
      targets: f.targets,
      stages: [],
      preflight: null,
      approved: null,
      dispatch_id: null,
      worker_id: null,
      verification: null,
      message: null,
    }),
    created: true,
  }));
  f.request.mockRejectedValueOnce(new Error('control reply lost'));
  await expect(prepareHostUpdate(f.transport, f.authority, f.targets, {}, f.stage)).rejects.toThrow(
    'control reply lost',
  );
  expect(f.stage).toHaveBeenCalledOnce();
  expect(f.request.mock.calls.map(([command]) => command.action)).toEqual(['begin', 'stage']);
});
