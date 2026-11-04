import { readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { hostUpdateActionsSchema } from '@puddle/shared';
import { atomicPrivateJson, digest } from '@puddle/shared/node';
import { acquireHostClaim, HostClaimBusy } from '../../../../src/security/claims.js';
import { acquireRuntimeController } from '../../../../src/runtime/ownership/storage.js';
import { HostUpdateConnector } from '../../../../src/updates/preflight/connector.js';
import * as lifetime from '../../../../src/updates/worker/lifetime.js';
import * as selection from '../../../../src/updates/worker/selection.js';
import * as verification from '../../../../src/updates/verification/completion.js';
import { startStoppedUpdateRecoveryWorker } from '../../../../src/updates/recovery/worker/supervisor.js';
import { executeStoppedUpdateRecovery } from '../../../../src/updates/recovery/worker/execute.js';
import {
  readUpdateRecoveryAttempts,
  requireEndedUpdateRecoveryWorkers,
  updateRecoveryDirectory,
} from '../../../../src/updates/recovery/worker/records.js';
import { recoveryWorkerFixture } from '../../../helpers/update-recovery.js';

async function fixture(selectionAttempted = false) {
  const f = await recoveryWorkerFixture();
  if (selectionAttempted) {
    const file = join(f.directory, 'actions.json');
    const journal = hostUpdateActionsSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    journal.actions[1]!.state = 'finished';
    journal.actions[2]!.state = 'started';
    atomicPrivateJson(file, journal);
    symlinkSync(f.release, join(f.home, 'bin/current'));
  }
  const job = await startStoppedUpdateRecoveryWorker(f.home, f.store.read()!, f.options);
  const changes: string[] = [];
  vi.spyOn(lifetime, 'inspectUpdateWorkerProcessGroup').mockResolvedValue(2147483647);
  vi.spyOn(HostUpdateConnector.prototype, 'inspect').mockResolvedValue({
    state: 'absent',
    identity: null,
    blockers: [],
  });
  const select = vi.spyOn(selection, 'selectUpdateStage').mockImplementation(async () => {
    expect(() => acquireHostClaim(f.home, 'daemon-controller')).toThrow(HostClaimBusy);
    changes.push('select');
    symlinkSync(f.release, join(f.home, 'bin/current'));
  });
  const verify = vi
    .spyOn(verification, 'awaitHostUpdateCompletion')
    .mockImplementation(async (_home, original, operation) => {
      expect(original).toEqual(f.job);
      expect(operation.phase).toBe('recovery_required');
      selection.verifyUpdateSelection(f.home, f.stage);
      changes.push('verify');
      return digest('fresh completion fixture');
    });
  const run = async (command: Parameters<typeof f.supervisor>[0]) => {
    expect(command.detached).toBe(false);
    if (command.args[1] === 'start') {
      acquireRuntimeController(f.home).release();
      f.state.stopped = false;
      changes.push('start');
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    return f.run(command);
  };
  return { ...f, recovery: job, changes, select, verify, run };
}

it.each([false, true])(
  'continues unattempted steps and verifies attempted selections without replay (selected=%s)',
  async (selected) => {
    const f = await fixture(selected);
    await executeStoppedUpdateRecovery(f.home, f.recovery, f.run);
    expect(f.changes).toEqual(selected ? ['start', 'verify'] : ['select', 'start', 'verify']);
    expect(f.select).toHaveBeenCalledTimes(selected ? 0 : 1);
    expect(f.store.read()?.phase).toBe('complete');
    const attempt = readUpdateRecoveryAttempts(f.home, f.job.operation_id).attempts[0]!;
    expect(attempt.execution).not.toBeNull();
    const journal = hostUpdateActionsSchema.parse(
      JSON.parse(
        readFileSync(
          join(updateRecoveryDirectory(f.home, f.job.operation_id), f.recovery.id, 'actions.json'),
          'utf8',
        ),
      ),
    );
    expect(journal.worker_id).toBe(attempt.execution!.id);
    expect(journal.actions.every(({ state }) => state === 'finished')).toBe(true);
    await expect(executeStoppedUpdateRecovery(f.home, f.recovery, f.run)).rejects.toThrow();
  },
);

it('retains a lost selection reply without starting the daemon or automatically dispatching another attempt', async () => {
  const f = await fixture();
  const select = f.select.getMockImplementation()!;
  f.select.mockImplementation(async (...args) => {
    await select(...args);
    throw new Error('selection reply lost');
  });
  await expect(executeStoppedUpdateRecovery(f.home, f.recovery, f.run)).rejects.toThrow(
    'reply lost',
  );
  expect(f.changes).toEqual(['select']);
  expect(f.store.read()?.phase).toBe('recovery_required');
  await expect(
    startStoppedUpdateRecoveryWorker(f.home, f.store.read()!, f.options),
  ).rejects.toThrow('executed recovery attempt');
  acquireHostClaim(f.home, 'daemon-controller').release();
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  expect(() => requireEndedUpdateRecoveryWorkers(f.home, f.store.read()!)).toThrow('still running');
  expect(kill).toHaveBeenCalledExactlyOnceWith(-2147483647, 0);
});

it('refuses all mutations when independent recovery worker isolation cannot be established', async () => {
  const f = await fixture();
  vi.mocked(lifetime.inspectUpdateWorkerProcessGroup).mockRejectedValueOnce(
    new Error('not independent'),
  );
  await expect(executeStoppedUpdateRecovery(f.home, f.recovery, f.run)).rejects.toThrow(
    'not independent',
  );
  expect(f.changes).toEqual([]);
  expect(readUpdateRecoveryAttempts(f.home, f.job.operation_id).attempts[0]!.execution).toBeNull();
});
