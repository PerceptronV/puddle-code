import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { hostReleaseCollectionSchema } from '@puddle/shared';
import { atomicPrivateJson } from '@puddle/shared/node';
import { acquireHostClaim } from '../../../../src/security/claims.js';
import { HostRemovalGuard } from '../../../../src/host/removal/guard.js';
import { reviewReleaseCollection } from '../../../../src/host/installation/collection/review.js';
import {
  executeReleaseCollection,
  inspectReleaseCollection,
  prepareReleaseCollection,
} from '../../../../src/host/installation/collection/execute.js';
import { collectionRelease } from '../../../helpers/release-collection.js';
import { removalInstallationFixture } from '../../../helpers/removal-service.js';

const runtimes = { releaseReferences: () => [], get: () => null };
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture() {
  const f = removalInstallationFixture();
  collectionRelease(f.home, '0.4.0~abc123');
  const release = collectionRelease(f.home, '0.3.9~abc123');
  let guard = f.guard;
  let controller = guard.acquireController();
  cleanups.push(() => {
    controller.release();
    guard.release();
    rmSync(f.home, { recursive: true, force: true });
  });
  return {
    ...f,
    release: release.path,
    get guard() {
      return guard;
    },
    reopen() {
      controller.release();
      guard.release();
      guard = HostRemovalGuard.acquire(f.home);
      controller = guard.acquireController();
    },
    async prepare() {
      const review = await reviewReleaseCollection(guard, runtimes, () => true);
      return (await prepareReleaseCollection(guard, runtimes, review.fingerprint, () => true))!;
    },
    quarantine(id: string) {
      return join(f.home, 'bin/.collection', id, '0.3.9~abc123');
    },
  };
}

describe('durable release collection', () => {
  it('collects verified old unused releases while preserving selectors, recent/unknown trees and linked user data', async () => {
    const f = fixture();
    const recent = collectionRelease(f.home, '0.4.1~abc123', false);
    const unknown = collectionRelease(f.home, '0.3.8~abc123');
    unlinkSync(join(unknown.path, '.puddle-stage.json'));
    const userData = join(f.home, 'native-conversation');
    writeFileSync(userData, 'keep this', { mode: 0o600 });
    symlinkSync(userData, join(f.release, 'native-link'));
    symlinkSync(f.home, join(f.release, 'home-link'));
    const plan = await f.prepare();
    expect(plan.releases.map(({ generation }) => generation)).toEqual(['0.3.9~abc123']);
    expect(await executeReleaseCollection(f.guard, runtimes, plan.id, () => true)).toEqual({
      id: plan.id,
      complete: true,
      remaining: 0,
    });
    expect(existsSync(f.release)).toBe(false);
    expect(existsSync(join(f.home, 'bin/current'))).toBe(true);
    expect(existsSync(recent.path)).toBe(true);
    expect(existsSync(unknown.path)).toBe(true);
    expect(readFileSync(userData, 'utf8')).toBe('keep this');
    expect(inspectReleaseCollection(f.guard)?.actions[0]?.state).toBe('finished');
    // A repeated exact request observes completion and performs no release deletion.
    expect((await executeReleaseCollection(f.guard, runtimes, plan.id, () => true)).complete).toBe(
      true,
    );
  });

  it('rejects a stale review before accepting a plan', async () => {
    const f = fixture();
    const review = await reviewReleaseCollection(f.guard, runtimes, () => true);
    collectionRelease(f.home, '0.3.8~abc123');
    await expect(
      prepareReleaseCollection(f.guard, runtimes, review.fingerprint, () => true),
    ).rejects.toThrow('review changed');
    expect(inspectReleaseCollection(f.guard)).toBeNull();
    expect(existsSync(f.release)).toBe(true);
  });

  it('rechecks new references before the first rename and permits explicit continuation after they disappear', async () => {
    const f = fixture();
    const plan = await f.prepare();
    symlinkSync(f.release, join(f.home, 'bin/runtime-current'));
    await expect(executeReleaseCollection(f.guard, runtimes, plan.id, () => true)).rejects.toThrow(
      'no longer eligible',
    );
    expect(existsSync(f.release)).toBe(true);
    expect(inspectReleaseCollection(f.guard)?.actions[0]?.state).toBe('started');
    unlinkSync(join(f.home, 'bin/runtime-current'));
    f.reopen();
    expect((await executeReleaseCollection(f.guard, runtimes, plan.id, () => true)).complete).toBe(
      true,
    );
  });

  it.each([false, true])(
    'recovers a failed intent write (durably written: %s) without losing the original tree',
    async (written) => {
      const f = fixture();
      const plan = await f.prepare();
      const write: typeof atomicPrivateJson = (path, value, options) => {
        if (hostReleaseCollectionSchema.parse(value).actions[0]?.state === 'started') {
          if (written) atomicPrivateJson(path, value, options);
          throw new Error('lost intent write');
        }
        atomicPrivateJson(path, value, options);
      };
      await expect(
        executeReleaseCollection(f.guard, runtimes, plan.id, () => true, { write }),
      ).rejects.toThrow('lost intent write');
      expect(existsSync(f.release)).toBe(true);
      f.reopen();
      expect(
        (await executeReleaseCollection(f.guard, runtimes, plan.id, () => true)).complete,
      ).toBe(true);
    },
  );

  it('recovers a crash after the atomic quarantine rename and before any deletion', async () => {
    const f = fixture();
    const plan = await f.prepare();
    const write: typeof atomicPrivateJson = (path, value, options) => {
      atomicPrivateJson(path, value, options);
      if (hostReleaseCollectionSchema.parse(value).actions[0]?.state === 'started') {
        renameSync(f.release, f.quarantine(plan.id));
        throw new Error('interrupted after rename');
      }
    };
    await expect(
      executeReleaseCollection(f.guard, runtimes, plan.id, () => true, { write }),
    ).rejects.toThrow('interrupted after rename');
    expect(existsSync(join(f.quarantine(plan.id), '.puddle-stage.json'))).toBe(true);
    f.reopen();
    expect((await executeReleaseCollection(f.guard, runtimes, plan.id, () => true)).complete).toBe(
      true,
    );
  });

  it.each([false, true])(
    'recovers a lost completion write (durably written: %s) from absence',
    async (written) => {
      const f = fixture();
      const plan = await f.prepare();
      const write: typeof atomicPrivateJson = (path, value, options) => {
        if (hostReleaseCollectionSchema.parse(value).actions[0]?.state === 'finished') {
          if (written) atomicPrivateJson(path, value, options);
          throw new Error('lost completion write');
        }
        atomicPrivateJson(path, value, options);
      };
      await expect(
        executeReleaseCollection(f.guard, runtimes, plan.id, () => true, { write }),
      ).rejects.toThrow('lost completion write');
      expect(existsSync(f.release)).toBe(false);
      f.reopen();
      expect(
        (await executeReleaseCollection(f.guard, runtimes, plan.id, () => true)).complete,
      ).toBe(true);
    },
  );

  it('resumes a bounded partial deletion after reacquiring exclusion and blocks a new reference to the detached source', async () => {
    const f = fixture();
    for (let i = 0; i < 600; i++)
      writeFileSync(join(f.release, `file-${i}`), 'fixture', { mode: 0o600 });
    const plan = await f.prepare();
    expect((await executeReleaseCollection(f.guard, runtimes, plan.id, () => true)).complete).toBe(
      false,
    );
    expect(existsSync(f.release)).toBe(false);
    expect(existsSync(f.quarantine(plan.id))).toBe(true);
    expect(inspectReleaseCollection(f.guard)?.actions[0]?.state).toBe('started');
    f.reopen();
    symlinkSync(f.release, join(f.home, 'bin/runtime-current'));
    await expect(
      executeReleaseCollection(f.guard, runtimes, plan.id, () => true),
    ).rejects.toThrow();
    expect(existsSync(f.quarantine(plan.id))).toBe(true);
    unlinkSync(join(f.home, 'bin/runtime-current'));
    expect((await executeReleaseCollection(f.guard, runtimes, plan.id, () => true)).complete).toBe(
      true,
    );
  });

  it('does not collect a replaced quarantined inode', async () => {
    const f = fixture();
    for (let i = 0; i < 520; i++)
      writeFileSync(join(f.release, `file-${i}`), 'fixture', { mode: 0o600 });
    const plan = await f.prepare();
    await executeReleaseCollection(f.guard, runtimes, plan.id, () => true);
    const target = f.quarantine(plan.id);
    renameSync(target, join(f.home, 'retained-original'));
    mkdirSync(target, { mode: 0o700 });
    writeFileSync(join(target, 'keep'), 'keep', { mode: 0o600 });
    await expect(executeReleaseCollection(f.guard, runtimes, plan.id, () => true)).rejects.toThrow(
      'identity changed',
    );
    expect(readFileSync(join(target, 'keep'), 'utf8')).toBe('keep');
  });

  it('retains a generation whose receipt changed after acceptance', async () => {
    const f = fixture();
    const plan = await f.prepare();
    collectionRelease(f.home, '0.3.9~abc123');
    await expect(executeReleaseCollection(f.guard, runtimes, plan.id, () => true)).rejects.toThrow(
      'no longer eligible',
    );
    expect(existsSync(f.release)).toBe(true);
  });

  it('keeps writer exclusion through execution and checks authority before every effect', async () => {
    const f = fixture();
    const plan = await f.prepare();
    let checks = 0;
    const authorised = () => {
      if (++checks > 1) expect(() => acquireHostClaim(f.home, 'host-update-control')).toThrow();
      return checks < 6;
    };
    await expect(executeReleaseCollection(f.guard, runtimes, plan.id, authorised)).rejects.toThrow(
      'authority expired',
    );
    expect(existsSync(f.release)).toBe(true);
    const claim = acquireHostClaim(f.home, 'host-update-control');
    claim.release();
    expect((await executeReleaseCollection(f.guard, runtimes, plan.id, () => true)).complete).toBe(
      true,
    );
  });

  it('rejects an unknown quarantine directory and never deletes its contents', async () => {
    const f = fixture();
    const plan = await f.prepare();
    const unknown = join(f.home, 'bin/.collection/unknown');
    mkdirSync(unknown, { recursive: true, mode: 0o700 });
    writeFileSync(join(unknown, 'keep'), 'keep', { mode: 0o600 });
    await expect(executeReleaseCollection(f.guard, runtimes, plan.id, () => true)).rejects.toThrow(
      'Unknown release collection quarantine',
    );
    expect(existsSync(join(unknown, 'keep'))).toBe(true);
    expect(existsSync(f.release)).toBe(true);
  });

  it('refuses to replace an unfinished operation and validates serial persisted intent', async () => {
    const f = fixture();
    collectionRelease(f.home, '0.3.8~abc123');
    const plan = await f.prepare();
    await expect(f.prepare()).rejects.toThrow('existing release collection');
    const corrupt = structuredClone(plan);
    corrupt.actions[1]!.state = 'started';
    atomicPrivateJson(join(f.home, 'installation/collection/current.json'), corrupt);
    await expect(executeReleaseCollection(f.guard, runtimes, plan.id, () => true)).rejects.toThrow(
      'serial prefix',
    );
    expect(existsSync(f.release)).toBe(true);
  });

  it('caps the accepted batch, retains bounded history and requires a new review for later candidates', async () => {
    const f = fixture();
    for (let i = 0; i < 32; i++) collectionRelease(f.home, `0.3.${i}~def456`);
    const first = await f.prepare();
    expect(first.releases).toHaveLength(32);
    expect((await executeReleaseCollection(f.guard, runtimes, first.id, () => true)).complete).toBe(
      true,
    );
    const second = await f.prepare();
    expect(second.releases).toHaveLength(1);
    expect(second.id).not.toBe(first.id);
    const previous = JSON.parse(
      readFileSync(join(f.home, 'installation/collection/last.json'), 'utf8'),
    );
    expect(previous.id).toBe(first.id);
    await expect(executeReleaseCollection(f.guard, runtimes, first.id, () => true)).rejects.toThrow(
      'identity changed',
    );
    expect(
      (await executeReleaseCollection(f.guard, runtimes, second.id, () => true)).complete,
    ).toBe(true);
    expect(await f.prepare()).toBeNull();
  });
});
