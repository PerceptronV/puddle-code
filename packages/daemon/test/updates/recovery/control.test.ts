import { connect } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@puddle/shared';
import { HostControlClient, readUpdateRecoveryAttempts } from '@puddle/shared/node/host-control';
import { ipcPath } from '@puddle/shared/node';
import { LeaseRegistry } from '../../../src/security/leases.js';
import { startHostControl } from '../../../src/security/control.js';
import { HostUpdateCoordinator } from '../../../src/updates/coordinator.js';
import { startUpdateRecoveryWorker } from '../../../src/updates/recovery/worker/supervisor.js';
import { recoveryWorkerFixture } from '../../helpers/update-recovery.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function fixture(lost = false) {
  const f = await recoveryWorkerFixture();
  const coordinator = new HostUpdateCoordinator({
    home: f.home,
    operations: f.store,
    installedRuntime: () => null,
    inspection: {
      inspect: async () => {
        throw new Error('No fresh installation');
      },
    },
    dispatch: async () => {
      throw new Error('No original dispatch');
    },
    continueRecovery: async (operation, authorised) => {
      await startUpdateRecoveryWorker(f.home, operation, {
        ...f.options,
        authorised,
        run: async (command) => {
          const result = await f.supervisor(command);
          if (lost && command.args[1] === 'start') throw new Error('Dispatch reply lost');
          return result;
        },
      });
    },
  });
  cleanups.push(() => coordinator.close());
  const leases = new LeaseRegistry();
  cleanups.push(() => leases.dispose());
  cleanups.push(
    await startHostControl(
      f.home,
      leases,
      () => ({ port: 7434, version: { version: '0.4.0', protocol: PROTOCOL_VERSION } }),
      (command, authorised) => coordinator.execute(command, authorised),
    ),
  );
  const client = new HostControlClient(async () => connect(ipcPath(f.home, 'host')), false);
  cleanups.push(() => client.close());
  await client.establish();
  return { ...f, client, coordinator };
}

it.each([false, true])(
  'records one continuation through private authority and exposes only requested public metadata (lost=%s)',
  async (lost) => {
    const f = await fixture(lost);
    const operation = f.store.read()!;
    const reply = await f.client.hostUpdate({
      action: 'recover',
      strategy: 'continue',
      reference: { id: operation.id, revision: operation.revision },
    });
    const attempt = readUpdateRecoveryAttempts(f.home, operation.id).attempts[0]!;
    expect(reply).toMatchObject({
      ok: true,
      operation: { phase: 'recovery_required' },
      recovery: { id: attempt.job.id, requested_revision: operation.revision, consumed: false },
    });
    expect(f.commands.map(({ args }) => args[1])).toEqual(['link', 'daemon-reload', 'start']);
    const oldStatus = await f.client.hostUpdate({ action: 'status', id: operation.id });
    expect(oldStatus).not.toHaveProperty('recovery');
    const status = await f.client.hostUpdate({
      action: 'status',
      id: operation.id,
      include_recovery: true,
    });
    expect(status).toEqual(reply);
    expect(JSON.stringify(status)).not.toContain(f.home);
    expect(JSON.stringify(status)).not.toContain('node_path');
    expect(readUpdateRecoveryAttempts(f.home, operation.id).attempts).toHaveLength(1);
  },
);

it('refuses continuation when participating authority disappears during inspection', async () => {
  const f = await fixture();
  let authorised = true;
  f.state.onProbe = () => {
    authorised = false;
  };
  const operation = f.store.read()!;
  const reply = await f.coordinator.execute(
    {
      action: 'recover',
      strategy: 'continue',
      reference: { id: operation.id, revision: operation.revision },
    },
    () => authorised,
  );
  expect(reply).toEqual({ ok: false, code: 'rejected', operation: null });
  expect(f.commands).toEqual([]);
  expect(readUpdateRecoveryAttempts(f.home, f.job.operation_id).attempts).toEqual([]);
});
