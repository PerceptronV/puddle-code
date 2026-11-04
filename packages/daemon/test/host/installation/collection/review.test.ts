import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { atomicPrivateJson, digest } from '@puddle/shared/node';
import { reviewReleaseCollection } from '../../../../src/host/installation/collection/review.js';
import { UNREFERENCED_RELEASE_RETENTION_MS } from '../../../../src/host/installation/collection/inventory.js';
import { HostRemovalServiceOperation } from '../../../../src/host/removal/operations/services.js';
import { acquireHostClaim } from '../../../../src/security/claims.js';
import { collectionRelease } from '../../../helpers/release-collection.js';
import { removalInstallationFixture as fixture } from '../../../helpers/removal-service.js';

const empty = { releaseReferences: () => [], get: () => null };

it('excludes update ledger writers for the whole asynchronous review and releases that claim afterwards', async () => {
  const f = fixture();
  const controller = f.guard.acquireController();
  try {
    let checks = 0;
    await reviewReleaseCollection(f.guard, empty, () => {
      if (++checks === 2) expect(() => acquireHostClaim(f.home, 'host-update-control')).toThrow();
      return true;
    });
    expect(checks).toBeGreaterThan(2);
    acquireHostClaim(f.home, 'host-update-control').release();
  } finally {
    controller.release();
    f.close();
  }
});

it('reviews old unreferenced generations while retaining both selectors, recent stages and unverified releases', async () => {
  const f = fixture();
  const controller = f.guard.acquireController();
  try {
    const selected = collectionRelease(f.home, '0.4.0~abc123');
    const runtime = collectionRelease(f.home, '0.4.1~abc123');
    const unused = collectionRelease(f.home, '0.4.2~abc123');
    const recent = collectionRelease(f.home, '0.4.3~abc123', false);
    const unverified = collectionRelease(f.home, '0.4.4~abc123');
    unlinkSync(join(unverified.path, '.puddle-stage.json'));
    symlinkSync(runtime.path, join(f.home, 'bin/runtime-current'));
    const review = await reviewReleaseCollection(f.guard, empty, () => true);
    expect(review.candidates).toEqual([unused.path]);
    expect(review.releases.find(({ path }) => path === selected.path)!.references).toContain(
      'selector:current',
    );
    expect(review.releases.find(({ path }) => path === runtime.path)!.references).toContain(
      'selector:runtime-current',
    );
    expect(review.releases.find(({ path }) => path === unverified.path)!.references).toContain(
      'unverified-release',
    );
    expect(review.releases.some(({ path }) => path === recent.path)).toBe(true);
    for (const release of review.releases) expect(existsSync(release.path)).toBe(true);
    const again = await reviewReleaseCollection(f.guard, empty, () => true);
    expect(again).toEqual(review);
    unlinkSync(join(f.home, 'bin/runtime-current'));
    symlinkSync(unused.path, join(f.home, 'bin/runtime-current'));
    const changed = await reviewReleaseCollection(f.guard, empty, () => true);
    expect(changed.fingerprint).not.toBe(review.fingerprint);
    expect(changed.candidates).toEqual([runtime.path]);
    const aged = await reviewReleaseCollection(
      f.guard,
      empty,
      () => true,
      Date.now() + UNREFERENCED_RELEASE_RETENTION_MS + 1000,
    );
    expect(aged.candidates).toContain(recent.path);
    expect(aged.fingerprint).not.toBe(changed.fingerprint);
  } finally {
    controller.release();
    f.close();
  }
});

it('retains update receipts and workers/recovery jobs even after their operation leaves bounded history', async () => {
  const f = fixture();
  const controller = f.guard.acquireController();
  try {
    const staged = collectionRelease(f.home, '0.4.1~abc123');
    const workerRelease = collectionRelease(f.home, '0.4.2~abc123');
    const recoveryRelease = collectionRelease(f.home, '0.4.3~abc123');
    const id = randomUUID();
    atomicPrivateJson(join(f.home, 'updates/operations.json'), {
      format: 1,
      current: {
        format: 1,
        id: randomUUID(),
        revision: 1,
        created_at: 1,
        updated_at: 1,
        phase: 'cancelled',
        targets: [{ component: 'daemon', version: staged.record.version }],
        stages: [{ record: staged.record, digest: digest(`${JSON.stringify(staged.record)}\n`) }],
        preflight: null,
        approved: null,
        dispatch_id: null,
        worker_id: null,
        verification: null,
        message: null,
      },
      history: [],
    });
    const service = (path: string) => ({
      kind: 'systemd',
      name: 'puddle-update.service',
      domain: null,
      release_path: path,
      node_path: join(path, 'bin/node'),
      entry_path: join(path, 'daemon/host-update.mjs'),
      installer_path: join(path, 'daemon/install.sh'),
    });
    atomicPrivateJson(join(f.home, 'updates/jobs', id, 'worker.json'), {
      ...service(workerRelease.path),
      format: 1,
      operation_id: id,
      dispatch_id: randomUUID(),
      dispatch_revision: 1,
      preflight: 'a'.repeat(64),
      state: 'dispatched',
    });
    atomicPrivateJson(join(f.home, 'updates/jobs', id, 'recovery/attempts.json'), {
      format: 1,
      attempts: [
        {
          execution: null,
          job: {
            format: 1,
            id: randomUUID(),
            operation_id: id,
            requested_revision: 1,
            revision: 2,
            original_dispatch_id: randomUUID(),
            original_worker_id: randomUUID(),
            preflight: 'a'.repeat(64),
            original_worker_digest: 'b'.repeat(64),
            actions_digest: 'c'.repeat(64),
            service: service(recoveryRelease.path),
          },
        },
      ],
    });
    const review = await reviewReleaseCollection(f.guard, empty, () => true);
    expect(review.candidates).toEqual([]);
    expect(review.releases.find(({ path }) => path === workerRelease.path)!.references).toContain(
      `worker:${id}`,
    );
    expect(
      review.releases.find(({ path }) => path === recoveryRelease.path)!.references[0],
    ).toMatch(/^recovery:/);
  } finally {
    controller.release();
    f.close();
  }
});

it('retains the release of a cancelled removal after the selector changes', async () => {
  const f = fixture();
  const controller = f.guard.acquireController();
  try {
    const original = collectionRelease(f.home, '0.4.0~abc123');
    const operation = await HostRemovalServiceOperation.prepare(
      f.guard,
      [await f.review()],
      f.options,
    );
    const id = operation.read().id;
    operation.cancel();
    const next = collectionRelease(f.home, '0.4.1~abc123');
    unlinkSync(join(f.home, 'bin/current'));
    symlinkSync(next.path, join(f.home, 'bin/current'));
    const review = await reviewReleaseCollection(f.guard, empty, () => true);
    expect(review.candidates).toEqual([]);
    expect(review.releases.find(({ path }) => path === original.path)!.references).toContain(
      `removal:${id}`,
    );
  } finally {
    controller.release();
    f.close();
  }
});

it.each([
  'runtime',
  'worker',
  'linked-release',
  'linked-runtime-root',
  'receipt',
  'authority',
  'controller',
])('refuses a collection review with unknown or changed %s evidence', async (kind) => {
  const f = fixture();
  const controller = f.guard.acquireController();
  try {
    const release = collectionRelease(f.home, '0.4.1~abc123');
    if (kind === 'runtime')
      mkdirSync(join(f.home, 'runtimes', randomUUID()), { recursive: true, mode: 0o700 });
    if (kind === 'worker')
      mkdirSync(join(f.home, 'updates/jobs', randomUUID()), { recursive: true, mode: 0o700 });
    if (kind === 'linked-release')
      symlinkSync(release.path, join(f.home, 'bin/versions/0.4.5~abc123'));
    if (kind === 'linked-runtime-root') symlinkSync(release.path, join(f.home, 'runtimes'));
    if (kind === 'receipt') writeFileSync(join(release.path, '.puddle-stage.json'), '{');
    if (kind === 'controller') controller.release();
    await expect(
      reviewReleaseCollection(f.guard, empty, () => kind !== 'authority'),
    ).rejects.toThrow();
    expect(existsSync(release.path)).toBe(true);
  } finally {
    controller.release();
    f.close();
  }
});
