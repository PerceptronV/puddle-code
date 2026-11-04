import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { HostRemovalGuard } from '../../../../src/host/removal/guard.js';
import { reviewReleaseCollection } from '../../../../src/host/installation/collection/review.js';
import {
  executeReleaseCollection,
  inspectReleaseCollection,
  prepareReleaseCollection,
} from '../../../../src/host/installation/collection/execute.js';
import { collectionRelease } from '../../../helpers/release-collection.js';
import { removalInstallationFixture } from '../../../helpers/removal-service.js';

it('reacquires crashed process claims and resumes an exact quarantine after SIGKILL', async () => {
  const f = removalInstallationFixture();
  let guard = f.guard;
  let controller = guard.acquireController();
  try {
    collectionRelease(f.home, '0.4.0~abc123');
    const release = collectionRelease(f.home, '0.3.9~abc123');
    const runtimes = { releaseReferences: () => [], get: () => null };
    const review = await reviewReleaseCollection(guard, runtimes, () => true);
    const plan = (await prepareReleaseCollection(guard, runtimes, review.fingerprint, () => true))!;
    const quarantine = join(f.home, 'bin/.collection', plan.id, release.record.generation);
    const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
    const entry = join(f.home, 'collection-fixture.mjs');
    symlinkSync(join(root, 'packages/daemon/node_modules'), join(f.home, 'node_modules'));
    await build({
      stdin: {
        contents: `
import { existsSync } from 'node:fs';
import { HostRemovalGuard } from './packages/daemon/src/host/removal/guard.ts';
import { executeReleaseCollection } from './packages/daemon/src/host/installation/collection/execute.ts';
const [home, id, quarantine] = process.argv.slice(2);
const guard = HostRemovalGuard.acquire(home);
guard.acquireController();
await executeReleaseCollection(guard, { releaseReferences: () => [], get: () => null }, id, () => {
  if (existsSync(quarantine)) process.kill(process.pid, 'SIGKILL');
  return true;
});
throw new Error('Expected the fixture to crash after quarantine');`,
        resolveDir: root,
      },
      outfile: entry,
      bundle: true,
      platform: 'node',
      format: 'esm',
      external: ['node-pty', 'better-sqlite3'],
      alias: {
        '@puddle/shared/node/host-control': join(root, 'packages/shared/src/node/host-control.ts'),
        '@puddle/shared/node': join(root, 'packages/shared/src/node/security.ts'),
        '@puddle/shared': join(root, 'packages/shared/src/index.ts'),
      },
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
    });
    controller.release();
    guard.release();
    const child = spawnSync(process.execPath, [entry, f.home, plan.id, quarantine], {
      cwd: f.home,
      env: { HOME: f.home, PUDDLE_HOME: f.home, PATH: '/usr/bin:/bin', TMPDIR: tmpdir() },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(child.stderr).toBe('');
    expect(child.signal).toBe('SIGKILL');
    expect(existsSync(release.path)).toBe(false);
    expect(existsSync(join(quarantine, '.puddle-stage.json'))).toBe(true);
    guard = HostRemovalGuard.acquire(f.home);
    controller = guard.acquireController();
    expect(inspectReleaseCollection(guard)?.actions[0]?.state).toBe('started');
    expect((await executeReleaseCollection(guard, runtimes, plan.id, () => true)).complete).toBe(
      true,
    );
    expect(existsSync(quarantine)).toBe(false);
    expect(existsSync(join(f.home, 'bin/current'))).toBe(true);
  } finally {
    controller.release();
    guard.release();
    rmSync(f.home, { recursive: true, force: true });
  }
});
