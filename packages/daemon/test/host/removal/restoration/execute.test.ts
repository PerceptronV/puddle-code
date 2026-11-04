import { randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { inspectHostRemoval } from '@puddle/shared/node/host-control';
import { atomicPrivateJson } from '@puddle/shared/node';
import { removalInstallationFixture } from '../../../helpers/removal-service.js';
import { HostRemovalServiceOperation } from '../../../../src/host/removal/operations/services.js';
import { HostRemovalServiceRestore } from '../../../../src/host/removal/restoration/services.js';
import { restoreRemovedHostServices } from '../../../../src/host/removal/restoration/execute.js';
import { HostRemovalGuard } from '../../../../src/host/removal/guard.js';

async function fixture() {
  const f = removalInstallationFixture('systemd');
  const operation = await HostRemovalServiceOperation.prepare(
    f.guard,
    [await f.review()],
    f.options,
  );
  const id = operation.read().id;
  expect(inspectHostRemoval(f.home)).toEqual({ state: 'removing', id });
  await operation.stop('daemon');
  const controller = f.guard.acquireController();
  await operation.unregister('daemon');
  const releaseClaims = () => {
    controller.release();
    f.guard.release();
  };
  return {
    ...f,
    release: realpathSync(f.release),
    id,
    operation,
    releaseClaims,
    close: () => {
      releaseClaims();
      f.close();
    },
  };
}

it('inspects recorded progress and restores under fresh exclusion without exposing private sources', async () => {
  const f = await fixture();
  try {
    expect(inspectHostRemoval(f.home)).toEqual({ state: 'removed', id: f.id });
    f.releaseClaims();
    await restoreRemovedHostServices(f.home, f.release, f.id, { ...f.options, resume: false });
    expect(inspectHostRemoval(f.home)).toEqual({ state: 'restored', id: f.id });
    expect(readFileSync(f.file, 'utf8')).toBe('reviewed definition');
    expect(f.commands.some(({ args }) => args.includes('start'))).toBe(false);
    expect(existsSync(join(f.home, 'puddle.db'))).toBe(false);
    const guard = HostRemovalGuard.acquire(f.home);
    guard.acquireController().release();
    guard.release();
  } finally {
    f.close();
  }
});

it.each(['identity', 'release', 'authority', 'missing-resume'] as const)(
  'refuses %s changes without clearing the fence or publishing a service',
  async (kind) => {
    const f = await fixture();
    try {
      f.releaseClaims();
      await expect(
        restoreRemovedHostServices(
          f.home,
          kind === 'release' ? f.home : f.release,
          kind === 'identity' ? randomUUID() : f.id,
          {
            ...f.options,
            authorised: () => kind !== 'authority',
            resume: kind === 'missing-resume',
          },
        ),
      ).rejects.toThrow();
      expect(inspectHostRemoval(f.home)).toEqual({ state: 'removed', id: f.id });
      expect(existsSync(f.file)).toBe(false);
      const guard = HostRemovalGuard.acquire(f.home);
      guard.acquireController().release();
      guard.release();
    } finally {
      f.close();
    }
  },
);

it('continues an exact lost publication acknowledgement without publishing twice', async () => {
  const f = await fixture();
  try {
    let writes = 0;
    const attempt = new HostRemovalServiceRestore(f.guard, f.operation, {
      ...f.options,
      write: (path, value, options) => {
        if (++writes === 3) throw new Error('Lost publication acknowledgement');
        atomicPrivateJson(path, value, options);
      },
    });
    await expect(attempt.restore()).rejects.toThrow('Lost publication');
    expect(inspectHostRemoval(f.home)).toEqual({ state: 'restoring', id: f.id });
    f.releaseClaims();
    await expect(
      restoreRemovedHostServices(f.home, f.release, f.id, {
        ...f.options,
        resume: false,
      }),
    ).rejects.toThrow('already recorded');
    await restoreRemovedHostServices(f.home, f.release, f.id, { ...f.options, resume: true });
    expect(inspectHostRemoval(f.home)).toEqual({ state: 'restored', id: f.id });
  } finally {
    f.close();
  }
});

it.each(['linked', 'malformed', 'source'] as const)(
  'refuses %s removal evidence during inspection',
  async (kind) => {
    const f = await fixture();
    try {
      if (kind === 'linked') {
        unlinkSync(f.record);
        symlinkSync(join(f.home, 'missing'), f.record);
      } else if (kind === 'malformed') writeFileSync(f.record, '{');
      else {
        const record = f.operation.read();
        record.services[0]!.source = Buffer.from('different private source').toString('base64');
        atomicPrivateJson(f.record, record);
      }
      expect(() => inspectHostRemoval(f.home)).toThrow();
    } finally {
      f.close();
    }
  },
);

it('refuses missing or mismatched restoration evidence after hand-off', async () => {
  const f = await fixture();
  try {
    f.releaseClaims();
    await restoreRemovedHostServices(f.home, f.release, f.id, { ...f.options, resume: false });
    const path = join(f.home, 'installation/removal/restore.json');
    const record = JSON.parse(readFileSync(path, 'utf8'));
    atomicPrivateJson(path, {
      ...record,
      actions: [{ action: 'restore-daemon', state: 'finished' }],
    });
    expect(() => inspectHostRemoval(f.home)).toThrow('unresolved');
    atomicPrivateJson(path, { ...record, removal_id: randomUUID() });
    expect(() => inspectHostRemoval(f.home)).toThrow('unresolved');
    unlinkSync(path);
    expect(() => inspectHostRemoval(f.home)).toThrow('Missing restoration evidence');
  } finally {
    f.close();
  }
});
