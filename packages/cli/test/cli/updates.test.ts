import { expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type HostUpdateReply } from '@puddle/shared';
import { candidateFixture } from '../../../daemon/test/updates/preflight/helpers.js';
import { runUpdates } from '../../src/cli/management/updates.js';

const mocks = vi.hoisted(() => ({ open: vi.fn(), acquire: vi.fn() }));
vi.mock('../../src/lib/transport/open.js', () => ({ openHostTransport: mocks.open }));
vi.mock('../../src/lib/auth/connection-authority.js', () => ({ acquireAuthority: mocks.acquire }));

function fixture() {
  const f = candidateFixture('daemon');
  let operation = f.store.preflight(f.operation, 'a'.repeat(64));
  operation = f.store.approve(operation, operation.preflight!);
  operation = f.store.dispatch(operation);
  const worker = f.store.claimExecution(operation, operation.dispatch_id!, operation.preflight!);
  operation = worker.failed('Host activation or verification requires inspection');
  worker.release();
  const status: HostUpdateReply = {
    ok: true,
    operation,
    review: {
      fingerprint: null,
      can_apply: false,
      blockers: [{ code: 'runtime_persistence_pending', target: 'affected-runtime-id' }],
      more_blockers: 0,
      affected: { terminals: 0, notebooks: 0, compilation: 0, programmes: 0 },
    },
  };
  const hostUpdate = vi.fn().mockResolvedValue(status);
  const close = vi.fn();
  const dispose = vi.fn();
  mocks.open.mockResolvedValue({ label: 'fixture-host', dispose });
  mocks.acquire.mockResolvedValue({
    state: 'ready',
    generation: 'fixture',
    version: { protocol: PROTOCOL_VERSION },
    hostUpdate,
    close,
  });
  const logger = { info: vi.fn(), warn: vi.fn() };
  return { operation, status, hostUpdate, close, dispose, logger };
}

it('prints live blockers and their runtime ids from ordinary update status', async () => {
  const f = fixture();
  await runUpdates({ cmd: 'updates', cancel: false, recover: false }, f.logger);
  expect(f.logger.info.mock.calls.flat().join('\n')).toContain(
    'affected-runtime-id: A runtime cannot confirm saved state',
  );
  expect(f.hostUpdate.mock.calls).toEqual([
    [{ action: 'status', id: undefined, include_recovery: true }],
  ]);
  expect(f.close).toHaveBeenCalledOnce();
  expect(f.dispose).toHaveBeenCalledOnce();
});

it.each(['verify-completion', 'continue'] as const)(
  'observes blockers after refused %s without repeating recovery',
  async (strategy) => {
    const f = fixture();
    f.hostUpdate
      .mockResolvedValueOnce(f.status)
      .mockResolvedValueOnce({ ok: false, code: 'failed', operation: f.operation });
    await expect(
      runUpdates(
        {
          cmd: 'updates',
          operation: f.operation.id,
          cancel: false,
          recover: strategy === 'verify-completion',
          continue: strategy === 'continue',
        },
        f.logger,
      ),
    ).rejects.toThrow(/not verified|not confirmed/);
    expect(f.hostUpdate.mock.calls.map(([command]) => command.action)).toEqual([
      'status',
      'recover',
      'status',
    ]);
    expect(f.hostUpdate.mock.calls[2]![0]).toEqual({
      action: 'status',
      id: f.operation.id,
      include_recovery: true,
    });
    expect(f.logger.info.mock.calls.flat().join('\n')).toContain('affected-runtime-id');
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.dispose).toHaveBeenCalledOnce();
  },
);
