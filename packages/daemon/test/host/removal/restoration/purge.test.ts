import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { atomicPrivateJson } from '@puddle/shared/node';
import {
  inspectHostRemoval,
  readHostPurgeRecord,
  requireNoHostRemoval,
} from '@puddle/shared/node/host-control';
import { removalHostFixture } from '../../../helpers/removal-host.js';
import { prepareHostRemoval, finishHostRemoval } from '../../../../src/host/removal/coordinator.js';
import {
  prepareHostPurge,
  applyHostPurge,
} from '../../../../src/host/removal/purge/coordinator.js';
import { restoreRemovedHostServices } from '../../../../src/host/removal/restoration/execute.js';
import { HostRemovalGuard } from '../../../../src/host/removal/guard.js';
import { HostRemovalServiceOperation } from '../../../../src/host/removal/operations/services.js';
import { HostRemovalServiceRestore } from '../../../../src/host/removal/restoration/services.js';
import { preparePurgedRestoration } from '../../../../src/host/removal/restoration/purge.js';
import { openDatabase } from '../../../../src/db/db.js';

async function purged() {
  const f = removalHostFixture();
  let boot = randomUUID();
  const options = { ...f.options, bootIdentity: async () => boot };
  const cycle = async () => {
    const review = await prepareHostRemoval(f.home, f.release, undefined, options);
    await finishHostRemoval(
      f.home,
      f.release,
      {
        id: review.id,
        fingerprint: review.fingerprint,
        attempt_id: randomUUID(),
        disposition: 'stop',
      },
      options,
    );
    await prepareHostPurge(f.home, f.release, review.id, options);
    boot = randomUUID();
    const ready = await prepareHostPurge(f.home, f.release, review.id, options);
    await applyHostPurge(
      f.home,
      f.release,
      { id: review.id, fingerprint: ready.fingerprint!, attempt_id: randomUUID() },
      options,
    );
    return review.id;
  };
  try {
    const id = await cycle();
    return {
      ...f,
      id,
      cycle,
      options,
      restore: (resume = false) =>
        restoreRemovedHostServices(f.home, f.release, id, { ...options, resume }),
    };
  } catch (error) {
    f.close();
    throw error;
  }
}

it('restores purged supervision without consulting a reused prior-boot PID or recreating old data', async () => {
  const f = await purged();
  const kill = process.kill.bind(process);
  const signal = vi
    .spyOn(process, 'kill')
    .mockImplementation((pid, value) => (pid === f.pid ? true : kill(pid, value)));
  try {
    const original = readFileSync(
      join(f.home, 'installation/removal/purged-services.json'),
      'utf8',
    );
    const purge = readFileSync(join(f.home, 'installation/removal/purged.json'), 'utf8');
    const inode = lstatSync(join(f.home, 'bin/.install-lock')).ino;
    expect(inspectHostRemoval(f.home)).toEqual({ state: 'removed', id: f.id });
    expect(existsSync(join(f.home, 'installation/removal/services.json'))).toBe(false);
    await f.restore();
    expect(inspectHostRemoval(f.home)).toEqual({ state: 'restored', id: f.id });
    expect(readFileSync(f.file, 'utf8')).toBe('reviewed definition');
    expect(readFileSync(join(f.home, 'supervisor'), 'utf8')).toBe('systemd\n');
    expect(readFileSync(join(f.home, 'installation/removal/restored-services.json'), 'utf8')).toBe(
      original,
    );
    expect(readFileSync(join(f.home, 'installation/removal/purged-services.json'), 'utf8')).toBe(
      original,
    );
    expect(readFileSync(join(f.home, 'installation/removal/purged.json'), 'utf8')).toBe(purge);
    expect(lstatSync(join(f.home, 'bin/.install-lock')).ino).toBe(inode);
    expect(signal.mock.calls.some(([pid]) => pid === f.pid)).toBe(false);
    expect(existsSync(join(f.home, 'puddle.db'))).toBe(false);
    expect(f.commands.some(({ args }) => args.includes('start'))).toBe(false);
    requireNoHostRemoval(f.home);
    await expect(f.restore()).rejects.toThrow('already handed off');
    expect(existsSync(join(f.home, 'installation/removal/services.json'))).toBe(false);
  } finally {
    signal.mockRestore();
    f.close();
  }
});

it.each([
  'same-boot',
  'missing-boot',
  'changed-proof',
  'pending-handoff',
  'missing-resume',
  'fresh-data',
] as const)(
  'refuses %s evidence before reconstituting a removal or publishing configuration',
  async (failure) => {
    const f = await purged();
    try {
      const record = readHostPurgeRecord(f.home)!;
      const options: Parameters<typeof restoreRemovedHostServices>[3] = {
        ...f.options,
        resume: false,
      };
      if (failure === 'same-boot') options.bootIdentity = async () => record.boot_id;
      if (failure === 'missing-boot') options.bootIdentity = async () => null;
      if (failure === 'changed-proof') {
        record.removal_digest = 'f'.repeat(64);
        atomicPrivateJson(join(f.home, 'installation/removal/purged.json'), record);
      }
      if (failure === 'pending-handoff')
        renameSync(
          join(f.home, 'installation/removal/purged.json'),
          join(f.home, 'installation/removal/purge.json'),
        );
      if (failure === 'missing-resume') options.resume = true;
      if (failure === 'fresh-data') openDatabase(join(f.home, 'puddle.db')).close();
      await expect(restoreRemovedHostServices(f.home, f.release, f.id, options)).rejects.toThrow();
      expect(existsSync(f.file)).toBe(false);
      expect(existsSync(join(f.home, 'supervisor'))).toBe(false);
      expect(existsSync(join(f.home, 'installation/removal/services.json'))).toBe(false);
    } finally {
      f.close();
    }
  },
);

it('observes a lost marker completion write without republishing definitions or appending to an old plan', async () => {
  const f = await purged();
  const guard = HostRemovalGuard.acquire(f.home);
  const controller = guard.acquireController();
  try {
    const purge = await preparePurgedRestoration(guard, f.id, () => true, f.options.bootIdentity);
    const operation = HostRemovalServiceOperation.open(guard, f.options);
    const write: typeof atomicPrivateJson = (path, value, options) => {
      const journal = value as { actions?: Array<{ action: string; state: string }> };
      if (
        journal.actions?.some(
          ({ action, state }) => action === 'restore-supervisor' && state === 'finished',
        )
      )
        throw new Error('Lost marker completion write');
      atomicPrivateJson(path, value, options);
    };
    const restore = new HostRemovalServiceRestore(guard, operation, { ...f.options, purge, write });
    await expect(restore.restore()).rejects.toThrow('Lost marker completion write');
    const source = lstatSync(f.file).ino;
    const marker = lstatSync(join(f.home, 'supervisor')).ino;
    expect(inspectHostRemoval(f.home)).toEqual({ state: 'restoring', id: f.id });
    const resumed = new HostRemovalServiceRestore(guard, operation, {
      ...f.options,
      purge,
      resume: true,
    });
    await resumed.restore();
    await resumed.handoff();
    expect(lstatSync(f.file).ino).toBe(source);
    expect(lstatSync(join(f.home, 'supervisor')).ino).toBe(marker);
  } finally {
    controller.release();
    guard.release();
    f.close();
  }
});

it('allows a second removal, purge and restoration without confusing its completed predecessor', async () => {
  const f = await purged();
  try {
    await f.restore();
    // A fresh daemon normally creates this database; this test exercises offline maintenance only.
    openDatabase(join(f.home, 'puddle.db')).close();
    const second = await f.cycle();
    expect(second).not.toBe(f.id);
    expect(inspectHostRemoval(f.home)).toEqual({ state: 'removed', id: second });
    await restoreRemovedHostServices(f.home, f.release, second, { ...f.options, resume: false });
    expect(inspectHostRemoval(f.home)).toEqual({ state: 'restored', id: second });
    requireNoHostRemoval(f.home);
  } finally {
    f.close();
  }
});

it('preserves a newly created supervisor marker instead of overwriting it', async () => {
  const f = await purged();
  try {
    writeFileSync(join(f.home, 'supervisor'), 'unknown\n', { mode: 0o600 });
    await expect(f.restore()).rejects.toThrow();
    expect(readFileSync(join(f.home, 'supervisor'), 'utf8')).toBe('unknown\n');
    expect(inspectHostRemoval(f.home)).toEqual({ state: 'restoring', id: f.id });
    await expect(f.restore(true)).rejects.toThrow('marker changed');
  } finally {
    f.close();
  }
});
