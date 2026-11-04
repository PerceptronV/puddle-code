import { readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { hostUpdateActionsSchema, runtimeControllerSchema } from '@puddle/shared';
import { atomicPrivateJson, digest } from '@puddle/shared/node';
import {
  acquireRuntimeController,
  readRuntimeController,
} from '../../../../src/runtime/ownership/storage.js';
import { acquireHostClaim } from '../../../../src/security/claims.js';
import { DATABASE_SCHEMA_VERSION } from '../../../../src/db/migrations/index.js';
import { HostUpdateConnector } from '../../../../src/updates/preflight/connector.js';
import * as lifetime from '../../../../src/updates/worker/lifetime.js';
import * as completion from '../../../../src/updates/verification/completion.js';
import { startUpdateRecoveryWorker } from '../../../../src/updates/recovery/worker/supervisor.js';
import { executeUpdateRecovery } from '../../../../src/updates/recovery/worker/execute.js';
import { claimUpdateContinuation } from '../../../../src/updates/recovery/continuation.js';
import { recoveryWorkerFixture } from '../../../helpers/update-recovery.js';
import { runtimeRelease } from '../../../helpers/runtime-release.js';

async function fixture(failed = false) {
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
  const run: typeof f.run = vi.fn(async (command) => {
    if (command.args[1] === 'start') {
      acquireRuntimeController(f.home).release();
      starts.push('start');
      f.state.stopped = false;
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    const result = await f.run(command);
    return failed
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
  return { ...f, run, options, starts };
}

it.each([false, true])(
  'starts a confirmed ended replacement once with current database evidence (failed=%s)',
  async (failed) => {
    const f = await fixture(failed);
    const before = readFileSync(f.dbFile);
    const controller = readRuntimeController(f.home);
    const reference = f.store.read()!;
    const job = await startUpdateRecoveryWorker(f.home, reference, f.options);
    expect(job.daemon_restart?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(readRuntimeController(f.home)).toEqual(controller);
    expect(readFileSync(f.dbFile)).toEqual(before);
    expect(await startUpdateRecoveryWorker(f.home, reference, f.options)).toEqual(job);
    expect(f.starts).toEqual([]);
    await executeUpdateRecovery(f.home, job, f.run);
    expect(f.starts).toEqual(['start']);
    expect(f.store.read()?.phase).toBe('complete');
    expect(readFileSync(f.dbFile)).toEqual(before);
  },
);

it('rejects a candidate compatible with the old checkpoint but unable to read later migrations', async () => {
  const f = await fixture();
  const checkpoint = JSON.parse(readFileSync(f.checkpoint, 'utf8'));
  checkpoint.daemon.schema_version = DATABASE_SCHEMA_VERSION - 1;
  atomicPrivateJson(f.checkpoint, checkpoint);
  writeFileSync(
    f.metadata,
    JSON.stringify({ ...f.capabilities, database_schema_version: DATABASE_SCHEMA_VERSION - 1 }),
  );
  await expect(startUpdateRecoveryWorker(f.home, f.store.read()!, f.options)).rejects.toThrow(
    'Current database schema',
  );
  expect(f.commands).toEqual([]);
  expect(f.starts).toEqual([]);
});

it.each(['future', 'restored', 'missing'])(
  'refuses %s application storage without starting or migrating it',
  async (damage) => {
    const f = await fixture();
    if (damage === 'missing') rmSync(f.dbFile);
    else {
      const db = new Database(f.dbFile);
      db.pragma(
        `user_version = ${damage === 'future' ? DATABASE_SCHEMA_VERSION + 1 : DATABASE_SCHEMA_VERSION - 1}`,
      );
      db.close();
    }
    const before = damage === 'missing' ? null : readFileSync(f.dbFile);
    await expect(startUpdateRecoveryWorker(f.home, f.store.read()!, f.options)).rejects.toThrow();
    expect(f.commands).toEqual([]);
    if (before) expect(readFileSync(f.dbFile)).toEqual(before);
  },
);

it('does not interpret a free stale active flag as permission to replace a held controller', async () => {
  const f = await fixture();
  const claim = acquireHostClaim(f.home, 'daemon-controller');
  try {
    await expect(startUpdateRecoveryWorker(f.home, f.store.read()!, f.options)).rejects.toThrow(
      'owns this host claim',
    );
    expect(f.commands).toEqual([]);
  } finally {
    claim.release();
  }
});

it.each(['controller', 'runtime-default'])(
  'rechecks accepted %s evidence in the independent worker',
  async (change) => {
    const f = await fixture();
    const job = await startUpdateRecoveryWorker(f.home, f.store.read()!, f.options);
    if (change === 'controller') {
      const previous = readRuntimeController(f.home);
      const controller = acquireRuntimeController(f.home);
      controller.release();
      expect(readRuntimeController(f.home).epoch).toBeGreaterThan(previous.epoch);
    } else runtimeRelease(f.home, '0.4.1').select();
    await expect(executeUpdateRecovery(f.home, job, f.run)).rejects.toThrow(
      'restart evidence changed',
    );
    expect(f.starts).toEqual([]);
    expect(f.store.read()?.phase).toBe('recovery_required');
  },
);

it('rechecks current storage immediately before releasing the controller for a new start', async () => {
  const f = await fixture();
  const recovery = await claimUpdateContinuation(f.home, f.store.read()!, () => true, f.run);
  try {
    if (recovery.mode !== 'restart') throw new Error('Missing restart claim');
    const db = new Database(f.dbFile);
    db.pragma(`user_version = ${DATABASE_SCHEMA_VERSION + 1}`);
    db.close();
    await expect(recovery.beforeStart()).rejects.toThrow('Current database schema');
    expect(f.starts).toEqual([]);
  } finally {
    recovery.release();
  }
});

it('holds controller exclusion and rechecks storage before releasing it for the new start', async () => {
  const f = await fixture();
  const recovery = await claimUpdateContinuation(f.home, f.store.read()!, () => true, f.run);
  try {
    expect(recovery.mode).toBe('restart');
    expect(() => acquireRuntimeController(f.home)).toThrow('owns this host claim');
    const record = runtimeControllerSchema.parse(
      JSON.parse(readFileSync(join(f.home, 'runtime-controller.json'), 'utf8')),
    );
    atomicPrivateJson(join(f.home, 'runtime-controller.json'), {
      ...record,
      active: !record.active,
    });
    if (recovery.mode !== 'restart') throw new Error('Missing restart claim');
    await expect(recovery.beforeStart()).rejects.toThrow('controller changed');
  } finally {
    recovery.release();
  }
  acquireHostClaim(f.home, 'daemon-controller').release();
});
