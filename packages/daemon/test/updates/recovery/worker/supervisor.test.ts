import { readUpdateRecoveryAttempts } from '@puddle/shared/node/host-control';
import { readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { HOST_UPDATE_RECOVERY_ATTEMPTS } from '@puddle/shared';
import { acquireHostClaim, HostClaimBusy } from '../../../../src/security/claims.js';
import { readRuntimeController } from '../../../../src/runtime/ownership/storage.js';
import { startUpdateRecoveryWorker } from '../../../../src/updates/recovery/worker/supervisor.js';
import { requireEndedUpdateRecoveryWorkers } from '../../../../src/updates/recovery/worker/records.js';
import { executeUpdateRecovery } from '../../../../src/updates/recovery/worker/execute.js';
import { recoveryWorkerFixture } from '../../../helpers/update-recovery.js';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { watchUpdateParticipation } from '@puddle/shared/node/host-control';

it.each(['before', 'after'] as const)(
  'honours input closure %s durable recovery acceptance',
  async (when) => {
    const f = await recoveryWorkerFixture();
    const input = new PassThrough();
    const participation = watchUpdateParticipation(input);
    input.resume();
    let closed = false;
    try {
      const pending = startUpdateRecoveryWorker(f.home, f.store.read()!, {
        ...f.options,
        authorised: () => !participation.signal.aborted,
        run: async (command) => {
          const reading = ['cat', 'show'].includes(command.args[1]!);
          if (!closed && (when === 'before' ? reading : !reading)) {
            closed = true;
            input.end();
            await setImmediate();
            expect(participation.signal.aborted).toBe(true);
          }
          return f.supervisor(command);
        },
      });
      if (when === 'before') {
        await expect(pending).rejects.toThrow('authority expired');
        expect(readUpdateRecoveryAttempts(f.home, f.job.operation_id).attempts).toHaveLength(0);
        expect(f.commands).toHaveLength(0);
      } else {
        await pending;
        expect(readUpdateRecoveryAttempts(f.home, f.job.operation_id).attempts).toHaveLength(1);
        expect(f.commands.map(({ args }) => args[1])).toEqual(['link', 'daemon-reload', 'start']);
      }
    } finally {
      participation.dispose();
      input.destroy();
    }
  },
);

it('durably accepts one independent bounded worker before dispatch and releases execution for that worker', async () => {
  const f = await recoveryWorkerFixture();
  const reference = f.store.read()!;
  const controller = readRuntimeController(f.home);
  const job = await startUpdateRecoveryWorker(f.home, reference, {
    ...f.options,
    run: async (command) => {
      if (!['cat', 'show'].includes(command.args[1]!)) {
        const recorded = readUpdateRecoveryAttempts(f.home, reference.id).attempts;
        expect(recorded).toHaveLength(1);
        expect(recorded[0]!.execution).toBeNull();
        expect(recorded[0]!.job.revision).toBe(f.store.read()!.revision);
        expect(() => requireEndedUpdateRecoveryWorkers(f.home, f.store.read()!)).toThrow(
          'not fenced',
        );
        for (const scope of ['daemon-controller', 'host-update-execution'])
          acquireHostClaim(f.home, scope).release();
        expect(() => acquireHostClaim(f.home, `host-update-dispatch:${reference.id}`)).toThrow(
          HostClaimBusy,
        );
      }
      return f.supervisor(command);
    },
  });
  expect(readRuntimeController(f.home)).toEqual(controller);
  expect(f.commands.map(({ args }) => args[1])).toEqual(['link', 'daemon-reload', 'start']);
  const definition = readFileSync(f.commands[0]!.args[2]!, 'utf8');
  expect(definition).toContain('RuntimeMaxSec=180');
  expect(definition).toContain('Restart=no');
  expect(definition).toContain('--recovery');
  expect(definition).not.toMatch(/PartOf=|BindsTo=|WantedBy=|puddled\.service/);
  expect(job.service.entry_path).toBe(realpathSync(join(f.release, 'daemon/host-update.mjs')));
  expect(
    await startUpdateRecoveryWorker(f.home, reference, {
      ...f.options,
      releasePath: '/missing',
    }),
  ).toEqual(job);
  expect(f.commands).toHaveLength(3);
});

it('never repeats a lost dispatch reply and rejects a late worker after a new recovery fence', async () => {
  const f = await recoveryWorkerFixture();
  const reference = f.store.read()!;
  let mutations = 0;
  await expect(
    startUpdateRecoveryWorker(f.home, reference, {
      ...f.options,
      run: async (command) => {
        if (['cat', 'show'].includes(command.args[1]!)) return f.run(command);
        mutations++;
        throw new Error('supervisor reply lost');
      },
    }),
  ).rejects.toThrow('reply lost');
  const job = readUpdateRecoveryAttempts(f.home, reference.id).attempts[0]!.job;
  expect(await startUpdateRecoveryWorker(f.home, reference, f.options)).toEqual(job);
  expect(mutations).toBe(1);
  f.store.claimRecovery(f.store.read()!).release();
  await expect(executeUpdateRecovery(f.home, job, f.supervisor)).rejects.toThrow('state changed');
  expect(f.commands).toHaveLength(0);
});

it('rejects unpinned executables and authority loss before dispatch', async () => {
  const f = await recoveryWorkerFixture();
  rmSync(join(f.release, 'bin/node'));
  symlinkSync(process.execPath, join(f.release, 'bin/node'));
  await expect(startUpdateRecoveryWorker(f.home, f.store.read()!, f.options)).rejects.toThrow(
    'pinned',
  );
  expect(readUpdateRecoveryAttempts(f.home, f.job.operation_id).attempts).toHaveLength(0);
  f.state.authorised = false;
  await expect(startUpdateRecoveryWorker(f.home, f.store.read()!, f.options)).rejects.toThrow(
    'authority expired',
  );
  expect(f.commands).toHaveLength(0);
});

it('bounds fresh explicit attempts while retaining all accepted dispatch evidence', async () => {
  const f = await recoveryWorkerFixture();
  for (let i = 0; i < HOST_UPDATE_RECOVERY_ATTEMPTS; i++)
    await startUpdateRecoveryWorker(f.home, f.store.read()!, f.options);
  const count = f.commands.length;
  await expect(startUpdateRecoveryWorker(f.home, f.store.read()!, f.options)).rejects.toThrow(
    'attempt limit',
  );
  expect(readUpdateRecoveryAttempts(f.home, f.job.operation_id).attempts).toHaveLength(
    HOST_UPDATE_RECOVERY_ATTEMPTS,
  );
  expect(f.commands).toHaveLength(count);
});
