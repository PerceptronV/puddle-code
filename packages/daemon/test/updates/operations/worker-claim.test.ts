import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { hostStageRecordSchema } from '@puddle/shared';
import { digest } from '@puddle/shared/node';
import { HostUpdateOperations } from '../../../src/updates/operations/store.js';
import { HostClaimBusy } from '../../../src/security/claims.js';

const root = mkdtempSync(join(tmpdir(), 'puddle-update-worker-test-'));
const entry = join(root, 'worker.mjs');
const children: ChildProcess[] = [];
beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const sqlite = require.resolve('better-sqlite3');
  await build({
    entryPoints: [
      fileURLToPath(new URL('../../helpers/update-operation-worker.ts', import.meta.url)),
    ],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    alias: {
      '@puddle/shared/node': fileURLToPath(
        new URL('../../../../shared/src/node/security.ts', import.meta.url),
      ),
      '@puddle/shared': fileURLToPath(new URL('../../../../shared/src/index.ts', import.meta.url)),
      'better-sqlite3': sqlite,
    },
    external: [sqlite],
  });
});
afterAll(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit');
      child.kill('SIGKILL');
      await stopped;
    }
  }
  rmSync(root, { recursive: true, force: true });
});

it('releases execution ownership after process death without replaying the consumed dispatch', async () => {
  const home = mkdtempSync(join(root, 'home-'));
  const store = new HostUpdateOperations(home);
  const impact = digest('preflight');
  const record = hostStageRecordSchema.parse({
    format: 1,
    component: 'runtime',
    generation: '1.2.3~ABC123',
    version: '1.2.3',
    protocol: { major: 1, minor: 0 },
    archive_sha256: digest('archive'),
    tree_sha256: digest('tree'),
    checksum_verified: true,
  });
  let operation = store.begin([{ component: 'runtime', version: '1.2.3' }]).operation;
  operation = store.staged(operation, { record, digest: digest(`${JSON.stringify(record)}\n`) });
  operation = store.preflight(operation, impact);
  operation = store.approve(operation, impact);
  operation = store.dispatch(operation);
  const launch = () => {
    const child = spawn(
      process.execPath,
      [entry, home, operation.id, operation.dispatch_id!, impact],
      {
        env: { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    children.push(child);
    return child;
  };
  const first = launch();
  let errors = '';
  first.stderr!.on('data', (chunk) => {
    errors = (errors + String(chunk)).slice(-4096);
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Worker did not claim the operation: ' + errors)),
      5000,
    );
    first.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    first.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Worker exited: ' + errors));
    });
    first.stdout!.once('data', (chunk) => {
      clearTimeout(timer);
      if (String(chunk) === 'claimed\n') resolve();
      else reject(new Error('Unexpected worker response'));
    });
  });
  expect(store.read()?.phase).toBe('applying');
  expect(() => store.requireRecovery(store.read()!, 'worker still running')).toThrow(HostClaimBusy);
  const duplicate = launch();
  expect((await once(duplicate, 'exit'))[0]).toBe(1);
  const stopped = once(first, 'exit');
  first.kill('SIGKILL');
  await stopped;
  const afterCrash = new HostUpdateOperations(home);
  expect(afterCrash.read()?.phase).toBe('applying');
  const replay = launch();
  expect((await once(replay, 'exit'))[0]).toBe(1);
  const recovery = afterCrash.requireRecovery(afterCrash.read()!, 'worker process ended');
  expect(recovery.phase).toBe('recovery_required');
  expect(afterCrash.begin(operation.targets).created).toBe(false);
});
