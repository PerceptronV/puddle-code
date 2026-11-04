import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readRuntimeController } from '../../../../src/runtime/ownership/storage.js';
import { startUpdateRecoveryWorker } from '../../../../src/updates/recovery/worker/supervisor.js';
import { executeUpdateRecovery } from '../../../../src/updates/recovery/worker/execute.js';
import { runningRecoveryFixture as fixture } from '../../../helpers/update-running-recovery.js';

it.each(['started', 'finished'] as const)(
  'observes a %s daemon start without another start, selection or controller epoch',
  async (start) => {
    const f = await fixture(start);
    const controller = readRuntimeController(f.home);
    const job = await startUpdateRecoveryWorker(f.home, f.store.read()!, f.options);
    await executeUpdateRecovery(f.home, job, f.run);
    expect(f.store.read()?.phase).toBe('complete');
    expect(readRuntimeController(f.home)).toEqual(controller);
    expect(f.running.changes).toEqual([]);
    expect(f.verify).toHaveBeenCalledTimes(3); // Dispatch, independent execution and completion.
  },
);

it('starts only the pending connector and observes a lost reply on the next explicit attempt', async () => {
  const f = await fixture('finished', true);
  const job = await startUpdateRecoveryWorker(f.home, f.store.read()!, f.options);
  f.running.loseStartReply = true;
  await expect(executeUpdateRecovery(f.home, job, f.run)).rejects.toThrow('start reply lost');
  expect(f.running.changes).toEqual(['start-connector']);
  expect(f.store.read()?.phase).toBe('recovery_required');
  const next = await startUpdateRecoveryWorker(f.home, f.store.read()!, f.options);
  await executeUpdateRecovery(f.home, next, f.run);
  expect(f.running.changes).toEqual(['start-connector']);
  expect(f.store.read()?.phase).toBe('complete');
});

it.each(['adoption', 'configuration', 'stopped'])(
  'refuses dispatch when replacement %s is unconfirmed',
  async (failure) => {
    const f = await fixture();
    if (failure === 'adoption') f.verify.mockRejectedValueOnce(new Error('Adoption unavailable'));
    if (failure === 'configuration') f.state.definition += 'Changed=yes\n';
    if (failure === 'stopped') f.state.stopped = true;
    await expect(startUpdateRecoveryWorker(f.home, f.store.read()!, f.options)).rejects.toThrow();
    expect(f.commands).toEqual([]);
    expect(f.running.changes).toEqual([]);
  },
);

it.each(['authority', 'selection'])(
  'rechecks replacement %s immediately before issuing a connector start',
  async (change) => {
    const f = await fixture('finished', true);
    const job = await startUpdateRecoveryWorker(f.home, f.store.read()!, f.options);
    let stoppedProbes = 0;
    await expect(
      executeUpdateRecovery(f.home, job, async (command) => {
        const result = await f.run(command);
        if (command.args[1] === 'show' && command.args.includes('puddle-connector.service')) {
          // Initial observation, pre-start observation, then the shared start helper's final probe.
          if (++stoppedProbes === 3) {
            if (change === 'authority') f.controller.release();
            else rmSync(join(f.home, 'bin/current'));
          }
        }
        return result;
      }),
    ).rejects.toThrow(change === 'authority' ? 'current adoption' : 'ENOENT');
    expect(stoppedProbes).toBe(3);
    expect(f.running.changes).toEqual([]);
    expect(f.store.read()?.phase).toBe('recovery_required');
  },
);
