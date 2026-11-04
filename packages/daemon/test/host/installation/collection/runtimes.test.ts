import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { atomicPrivateJson } from '@puddle/shared/node';
import { reviewReleaseCollection } from '../../../../src/host/installation/collection/review.js';
import { runtimeCheckpointOwner } from '../../../../src/updates/checkpoints/store.js';
import { runtimeBindingIdentity } from '../../../../src/runtime/transport/connections.js';
import { runtimeDatabase } from '../../../helpers/runtime-database.js';
import { removalInstallationFixture } from '../../../helpers/removal-service.js';
import { collectionRelease } from '../../../helpers/release-collection.js';

it('pages real SQLite bindings and retains ended owners, their helper Node and checkpoint references', async () => {
  const runtime = runtimeDatabase();
  runtime.controller.release();
  const f = removalInstallationFixture('systemd', runtime.home);
  const controller = f.guard.acquireController();
  try {
    const owner = collectionRelease(f.home, '0.4.1~abc123');
    const helper = collectionRelease(f.home, '0.4.2~abc123');
    const checkpoint = collectionRelease(f.home, '0.4.3~abc123');
    const service = collectionRelease(f.home, '0.4.4~abc123');
    runtime.db
      .prepare(
        "UPDATE runtime_bindings SET release_path = ?, state = 'exited' WHERE runtime_id = ?",
      )
      .run(owner.path, runtime.binding.runtime_id);
    expect(runtime.runtimes.live()).toEqual([]);
    const page = runtime.runtimes.releaseReferences('', 1);
    expect(page).toEqual([{ runtime_id: runtime.binding.runtime_id, release_path: owner.path }]);
    expect(runtime.runtimes.releaseReferences(page[0]!.runtime_id, 1)).toEqual([]);
    expect(() => runtime.runtimes.releaseReferences('', 257)).toThrow();
    const supervisor = {
      format: 1,
      identity: runtimeBindingIdentity(runtime.runtimes.get(runtime.binding.runtime_id)!),
      kind: 'launchd',
      name: `dev.puddle.runtime.12345678.${runtime.binding.runtime_id}`,
      domain: `gui/${process.getuid!()}`,
      node_path: join(service.path, 'bin/node'),
      entry_path: join(service.path, 'daemon/puddler.mjs'),
      state: 'removed',
    };
    atomicPrivateJson(join(runtime.directory, 'supervisor.json'), supervisor);
    atomicPrivateJson(join(runtime.directory, 'assets.json'), {
      format: 1,
      node_path: join(helper.path, 'bin/node'),
      files: {},
    });
    const id = randomUUID();
    atomicPrivateJson(join(f.home, 'updates/checkpoints', `${id}.json`), {
      format: 1,
      operation_id: id,
      dispatch_id: randomUUID(),
      preflight: 'a'.repeat(64),
      captured_at: 1,
      daemon: {
        pid: 123,
        version: '0.4.0',
        controller: { id: randomUUID(), epoch: 1 },
        schema_version: 39,
      },
      owners: [
        {
          ...runtimeCheckpointOwner(runtime.runtimes.get(runtime.binding.runtime_id)!),
          release_path: checkpoint.path,
        },
      ],
    });
    const review = await reviewReleaseCollection(f.guard, runtime.runtimes, () => true);
    expect(review.candidates).toEqual([]);
    expect(review.releases.find(({ path }) => path === owner.path)!.references).toContain(
      `runtime:${runtime.binding.runtime_id}`,
    );
    expect(review.releases.find(({ path }) => path === helper.path)!.references).toContain(
      `helper:${runtime.binding.runtime_id}`,
    );
    expect(review.releases.find(({ path }) => path === checkpoint.path)!.references).toContain(
      `checkpoint:${id}`,
    );
    expect(review.releases.find(({ path }) => path === service.path)!.references).toContain(
      `runtime-service:${runtime.binding.runtime_id}`,
    );
    supervisor.identity.incarnation = randomUUID();
    atomicPrivateJson(join(runtime.directory, 'supervisor.json'), supervisor);
    await expect(reviewReleaseCollection(f.guard, runtime.runtimes, () => true)).rejects.toThrow(
      'service identity changed',
    );
  } finally {
    controller.release();
    f.close();
    await runtime.reconciler.close();
    runtime.db.close();
  }
});
