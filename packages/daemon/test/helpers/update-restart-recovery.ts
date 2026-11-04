import { readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import { hostUpdateActionsSchema } from '@puddle/shared';
import { atomicPrivateJson, digest } from '@puddle/shared/node';
import {
  readUpdateRecoveryAttempts,
  updateRecoveryDirectory,
} from '@puddle/shared/node/host-control';
import { acquireRuntimeController } from '../../src/runtime/ownership/storage.js';
import { acquireHostClaim } from '../../src/security/claims.js';
import { HostUpdateConnector } from '../../src/updates/preflight/connector.js';
import * as lifetime from '../../src/updates/worker/lifetime.js';
import * as completion from '../../src/updates/verification/completion.js';
import { recoveryWorkerFixture } from './update-recovery.js';
import { runtimeRelease } from './runtime-release.js';

export async function restartRecoveryFixture(failed = false, rateLimited = false) {
  const f = await recoveryWorkerFixture();
  const file = join(f.directory, 'actions.json');
  const journal = hostUpdateActionsSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  journal.actions.forEach((action) => {
    action.state =
      action.action === 'start-connector'
        ? 'planned'
        : action.action === 'start-daemon'
          ? 'started'
          : 'finished';
  });
  atomicPrivateJson(file, journal);
  symlinkSync(f.release, join(f.home, 'bin/current'));
  runtimeRelease(f.home, '0.4.0').select();
  // A crashed daemon leaves an active flag, but its kernel-backed claim is free.
  const controller = acquireRuntimeController(f.home);
  controller.release();
  atomicPrivateJson(join(f.home, 'runtime-controller.json'), controller.record);
  vi.spyOn(lifetime, 'inspectUpdateWorkerProcessGroup').mockResolvedValue(2147483647);
  vi.spyOn(HostUpdateConnector.prototype, 'inspect').mockResolvedValue({
    state: 'absent',
    identity: null,
    blockers: [],
  });
  vi.spyOn(completion, 'awaitHostUpdateCompletion').mockResolvedValue(
    digest('fresh adoption fixture'),
  );
  const starts: string[] = [];
  const reset = { limited: rateLimited, failed, lost: false, after: () => {} };
  const run: typeof f.run = vi.fn(async (command) => {
    if (command.args[1] === 'reset-failed') {
      expect(() => acquireHostClaim(f.home, 'daemon-controller')).toThrow('owns this host claim');
      const attempt = readUpdateRecoveryAttempts(f.home, f.job.operation_id).attempts.at(-1)!;
      const actions = hostUpdateActionsSchema.parse(
        JSON.parse(
          readFileSync(
            join(
              updateRecoveryDirectory(f.home, f.job.operation_id),
              attempt.job.id,
              'actions.json',
            ),
            'utf8',
          ),
        ),
      );
      expect(actions.actions.find(({ action }) => action === 'start-daemon')?.state).toBe(
        'started',
      );
      starts.push('reset-failed');
      reset.limited = false;
      reset.failed = false;
      reset.after();
      if (reset.lost) throw new Error('Reset reply lost');
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (command.args[1] === 'start') {
      acquireRuntimeController(f.home).release();
      starts.push('start');
      f.state.stopped = false;
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    const result = await f.run(command);
    result.stdout = result.stdout.replace(
      'Result=success',
      `Result=${reset.limited ? 'start-limit-hit' : reset.failed ? 'exit-code' : 'success'}`,
    );
    return reset.failed
      ? {
          ...result,
          stdout: result.stdout.replace(
            'ActiveState=inactive\nSubState=dead',
            'ActiveState=failed\nSubState=failed',
          ),
        }
      : result;
  });
  const options = {
    ...f.options,
    run: async (command: Parameters<typeof f.run>[0]) =>
      ['cat', 'show'].includes(command.args[1]!) ? run(command) : f.supervisor(command),
  };
  return { ...f, run, options, starts, reset };
}
