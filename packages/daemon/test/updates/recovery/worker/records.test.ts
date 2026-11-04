import {
  readUpdateRecoveryAttempts,
  updateRecoveryDirectory,
} from '@puddle/shared/node/host-control';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { atomicPrivateJson } from '@puddle/shared/node';
import { HOST_UPDATE_RECOVERY_BYTES } from '@puddle/shared';
import {
  HostUpdateRecoveryAttempts,
  requireEndedUpdateRecoveryWorkers,
} from '../../../../src/updates/recovery/worker/records.js';
import { startUpdateRecoveryWorker } from '../../../../src/updates/recovery/worker/supervisor.js';
import { recoveryWorkerFixture } from '../../../helpers/update-recovery.js';

const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch {
      /* Fixture already ended. */
    }
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  }
});

it('consumes a dispatch once and refuses changed job identity or expired authority before writing lifetime', async () => {
  const f = await recoveryWorkerFixture();
  const job = await startUpdateRecoveryWorker(f.home, f.store.read()!, f.options);
  const store = new HostUpdateRecoveryAttempts(f.home, job.operation_id);
  const claim = f.store.claimRecovery(f.store.read()!);
  try {
    expect(() => store.claim({ ...job, actions_digest: '0'.repeat(64) }, 123, () => {})).toThrow(
      'unconsumed dispatch',
    );
    expect(() =>
      store.claim(job, 123, () => {
        throw new Error('authority expired');
      }),
    ).toThrow('authority expired');
    expect(readUpdateRecoveryAttempts(f.home, job.operation_id).attempts[0]!.execution).toBeNull();
    const attempt = store.claim(job, 123, () => {});
    expect(attempt.execution?.process_group).toBe(123);
    expect(() => store.claim(job, 123, () => {})).toThrow('unconsumed dispatch');
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    });
    expect(() => requireEndedUpdateRecoveryWorkers(f.home, claim.operation)).toThrow('denied');
    expect(kill).toHaveBeenCalledExactlyOnceWith(-123, 0);
  } finally {
    claim.release();
  }
});

it('refuses malformed, oversized and mismatched recovery ledgers without treating them as no attempts', async () => {
  const f = await recoveryWorkerFixture();
  const job = await startUpdateRecoveryWorker(f.home, f.store.read()!, f.options);
  const file = join(updateRecoveryDirectory(f.home, job.operation_id), 'attempts.json');
  const original = readFileSync(file);
  for (const value of ['{', ' '.repeat(HOST_UPDATE_RECOVERY_BYTES + 1)]) {
    writeFileSync(file, value);
    expect(() => readUpdateRecoveryAttempts(f.home, job.operation_id)).toThrow();
  }
  writeFileSync(file, original);
  const ledger = readUpdateRecoveryAttempts(f.home, job.operation_id);
  ledger.attempts[0]!.job.preflight = '0'.repeat(64);
  atomicPrivateJson(file, ledger);
  const claim = f.store.claimRecovery(f.store.read()!);
  try {
    expect(() => requireEndedUpdateRecoveryWorkers(f.home, claim.operation)).toThrow('not fenced');
  } finally {
    claim.release();
  }
});

it('retains recovery exclusion while a command child outlives its worker', async () => {
  const f = await recoveryWorkerFixture();
  const job = await startUpdateRecoveryWorker(f.home, f.store.read()!, f.options);
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
  const descendant = Number(String((await once(child.stdout!, 'data'))[0]).trim());
  const claim = f.store.claimRecovery(f.store.read()!);
  try {
    new HostUpdateRecoveryAttempts(f.home, job.operation_id).claim(job, child.pid!, () => {});
    const exited = once(child, 'exit');
    child.stdin!.end('exit');
    await exited;
    expect(() => requireEndedUpdateRecoveryWorkers(f.home, claim.operation)).toThrow(
      'still running',
    );
    process.kill(descendant, 'SIGKILL');
    await vi.waitFor(() =>
      expect(() => requireEndedUpdateRecoveryWorkers(f.home, claim.operation)).not.toThrow(),
    );
  } finally {
    claim.release();
  }
});
