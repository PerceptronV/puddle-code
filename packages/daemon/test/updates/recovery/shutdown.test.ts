import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { hostUpdateActionsSchema } from '@puddle/shared';
import { atomicPrivateJson, digest } from '@puddle/shared/node';
import { acquireHostClaim, HostClaimBusy } from '../../../src/security/claims.js';
import {
  acquireRuntimeController,
  readRuntimeController,
} from '../../../src/runtime/ownership/storage.js';
import { stoppedUpdateRecovery as fixture } from '../../helpers/update-recovery.js';

it('recovers the original controller hand-off after a lost stop reply without opening SQLite or issuing component commands', async () => {
  const f = await fixture();
  const before = readRuntimeController(f.home);
  const database = readFileSync(f.dbFile);
  const checkpoint = readFileSync(f.checkpoint);
  const recovery = await f.claim();
  try {
    expect(recovery.actions.actions).toContainEqual({ action: 'stop-daemon', state: 'started' });
    expect(recovery.checkpointDigest).toBe(digest(checkpoint.toString()));
    expect(readRuntimeController(f.home)).toEqual(before);
    for (const scope of [
      'daemon-controller',
      'host-update-execution',
      `host-update-dispatch:${f.job.operation_id}`,
    ])
      expect(() => acquireHostClaim(f.home, scope)).toThrow(HostClaimBusy);
    expect(readFileSync(f.dbFile)).toEqual(database);
    expect(f.store.read()?.phase).toBe('recovery_required');
    expect(f.run.mock.calls.every(([command]) => ['show', 'cat'].includes(command.args[1]!))).toBe(
      true,
    );
  } finally {
    recovery.release();
  }
  expect(() => recovery.check()).toThrow('released');
  for (const scope of [
    'daemon-controller',
    'host-update-execution',
    `host-update-dispatch:${f.job.operation_id}`,
  ])
    acquireHostClaim(f.home, scope).release();
});

it.each([
  'journal',
  'unattempted',
  'checkpoint',
  'controller',
  'active',
  'definition',
  'running',
  'unknown-schema',
  'old-schema',
] as const)(
  'retains recovery and releases all claims after invalid %s evidence',
  async (failure) => {
    const f = await fixture();
    if (failure === 'journal') rmSync(join(f.directory, 'actions.json'));
    if (failure === 'unattempted') {
      const path = join(f.directory, 'actions.json');
      const journal = hostUpdateActionsSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
      journal.actions[1]!.state = 'planned';
      atomicPrivateJson(path, journal);
    }
    if (failure === 'checkpoint') rmSync(f.checkpoint);
    if (failure === 'controller') acquireRuntimeController(f.home).release();
    if (failure === 'active')
      atomicPrivateJson(join(f.home, 'runtime-controller.json'), {
        ...readRuntimeController(f.home),
        active: true,
      });
    if (failure === 'definition') f.state.definition += '# changed\n';
    if (failure === 'running') f.state.stopped = false;
    if (failure === 'unknown-schema' || failure === 'old-schema') {
      writeFileSync(
        f.metadata,
        JSON.stringify({
          ...f.capabilities,
          database_schema_version: failure === 'unknown-schema' ? undefined : 0,
        }),
      );
    }
    await expect(f.claim()).rejects.toThrow();
    expect(f.store.read()?.phase).toBe('recovery_required');
    for (const scope of [
      'daemon-controller',
      'host-update-execution',
      `host-update-dispatch:${f.job.operation_id}`,
    ])
      acquireHostClaim(f.home, scope).release();
  },
);

it('rechecks authority and worker lifetime after asynchronous supervisor inspection', async () => {
  const f = await fixture();
  f.state.onProbe = () => {
    f.state.authorised = false;
  };
  await expect(f.claim()).rejects.toThrow('authority expired');
  acquireHostClaim(f.home, 'daemon-controller').release();
  f.state.authorised = true;
  f.state.onProbe = () => {
    vi.spyOn(process, 'kill').mockReturnValue(true);
  };
  await expect(f.claim()).rejects.toThrow('still running');
  acquireHostClaim(f.home, 'daemon-controller').release();
});
