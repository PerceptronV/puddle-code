import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runtimeDatabase } from '../../helpers/runtime-database.js';
import { removalInstallationFixture } from '../../helpers/removal-service.js';
import { acquireHostClaim } from '../../../src/security/claims.js';
import { retirePurgeRuntimes } from '../../../src/host/removal/purge/runtimes.js';

it('never treats an exited database row as proof that its owner or delayed launch has ended', async () => {
  const runtime = runtimeDatabase();
  runtime.controller.release();
  runtime.db
    .prepare("UPDATE runtime_bindings SET state = 'exited' WHERE runtime_id = ?")
    .run(runtime.binding.runtime_id);
  const f = removalInstallationFixture('systemd', runtime.home);
  const controller = f.guard.acquireController();
  let owner: ReturnType<typeof acquireHostClaim> | undefined = acquireHostClaim(
    runtime.home,
    `runtime:${runtime.binding.runtime_id}`,
  );
  try {
    await expect(
      retirePurgeRuntimes(f.guard, () => f.guard.requireController(), f.run),
    ).rejects.toThrow('ownership remains live');
    expect(existsSync(join(runtime.directory, 'retired.json'))).toBe(false);
    owner.release();
    owner = undefined;
    await retirePurgeRuntimes(f.guard, () => f.guard.requireController(), f.run);
    expect(existsSync(join(runtime.directory, 'retired.json'))).toBe(true);
  } finally {
    owner?.release();
    controller.release();
    await runtime.reconciler.close();
    runtime.db.close();
    f.close();
  }
});
