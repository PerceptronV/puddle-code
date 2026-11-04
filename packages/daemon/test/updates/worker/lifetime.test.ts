import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { atomicPrivateJson, readPrivateJson } from '@puddle/shared/node';
import {
  runCompilationCommand,
  type CompilationCommandRunner,
} from '../../../src/compilation/process.js';
import {
  recordUpdateWorkerLifetime,
  requireEndedUpdateWorker,
} from '../../../src/updates/worker/lifetime.js';
import { updateWorkerDirectory } from '../../../src/updates/worker/supervisor.js';
import { acceptedCheckpointUpdate, checkpointWorker } from '../../helpers/update-checkpoint.js';
import { systemdObservation } from '../../helpers/host-supervision.js';
import { randomUUID } from 'node:crypto';

const homes: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* Already ended. */
      }
    }
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'puddle-update-lifetime-'));
  homes.push(home);
  const accepted = acceptedCheckpointUpdate(home, 'runtime');
  const job = checkpointWorker(home, accepted, {
    pid: 123,
    controller: { id: randomUUID(), epoch: 1 },
  });
  const worker = accepted.store.claimExecution(accepted.operation, job.dispatch_id, job.preflight);
  return { home, ...accepted, job, worker };
}

it('retains uncertainty while an installer child outlives the worker, then accepts the ended group', async () => {
  const f = fixture();
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { spawn } from 'node:child_process';
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: false });
    console.log(child.pid);
    process.stdin.once('data', () => process.exit(0));
  `,
    ],
    {
      detached: true,
      env: { HOME: f.home, PATH: '/usr/bin:/bin' },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  children.push(child);
  const childPid = Number(String((await once(child.stdout!, 'data'))[0]).trim());
  expect(childPid).toBeGreaterThan(0);
  const run: CompilationCommandRunner = async (command) =>
    command.file === '/bin/ps'
      ? runCompilationCommand(command)
      : { exitCode: 0, stdout: systemdObservation(child.pid!, f.job.name), stderr: '' };
  try {
    await recordUpdateWorkerLifetime(f.home, f.job, f.worker.operation, run, child.pid!);
    const operation = f.worker.failed('lost reply');
    f.worker.release();
    expect(() => requireEndedUpdateWorker(f.home, f.job, operation)).toThrow('still running');
    const exit = once(child, 'exit');
    child.stdin!.end('exit');
    await exit;
    expect(() => requireEndedUpdateWorker(f.home, f.job, operation)).toThrow('still running');
    process.kill(childPid, 'SIGKILL');
    await vi.waitFor(() =>
      expect(() => requireEndedUpdateWorker(f.home, f.job, operation)).not.toThrow(),
    );
  } finally {
    f.worker.release();
  }
});

it('refuses unknown groups, mismatched dispatches and permission errors without sending a signal', async () => {
  const f = fixture();
  try {
    const run: CompilationCommandRunner = async (command) => ({
      exitCode: 0,
      stdout: command.file === '/bin/ps' ? '456\n' : systemdObservation(456, f.job.name),
      stderr: '',
    });
    await expect(
      recordUpdateWorkerLifetime(
        f.home,
        f.job,
        f.worker.operation,
        async (command) =>
          command.file === '/bin/ps' ? { exitCode: 0, stdout: '1\n', stderr: '' } : run(command),
        456,
      ),
    ).rejects.toThrow('process group');
    await recordUpdateWorkerLifetime(f.home, f.job, f.worker.operation, run, 456);
    await expect(
      recordUpdateWorkerLifetime(f.home, f.job, f.worker.operation, run, 456),
    ).rejects.toThrow('already recorded');
    const operation = f.worker.failed('lost reply');
    f.worker.release();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    });
    expect(() => requireEndedUpdateWorker(f.home, f.job, operation)).toThrow('denied');
    expect(kill).toHaveBeenCalledExactlyOnceWith(-456, 0);
    kill.mockClear();
    const file = join(updateWorkerDirectory(f.home, f.job.operation_id), 'lifetime.json');
    atomicPrivateJson(file, {
      ...(readPrivateJson(file, 4096) as object),
      dispatch_id: randomUUID(),
    });
    expect(() => requireEndedUpdateWorker(f.home, f.job, operation)).toThrow('match recovery');
    expect(kill).not.toHaveBeenCalled();
  } finally {
    f.worker.release();
  }
});
