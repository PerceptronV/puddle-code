import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNative } from '../../scripts/build-native.mjs';

if (process.platform !== 'darwin') {
  console.log('Native Command key-up check requires macOS.');
  process.exit(0);
}
const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 'puddle-key-up-'));
try {
  buildNative(directory);
  execFileSync(
    'xcrun',
    [
      'clang',
      '-bundle',
      '-undefined',
      'dynamic_lookup',
      '-fobjc-arc',
      '-framework',
      'AppKit',
      '-I',
      require('node-api-headers').include_dir,
      join(here, 'post-key-up.m'),
      '-o',
      join(directory, 'post-key-up.node'),
    ],
    { stdio: 'inherit' },
  );
  const result = spawnSync(require('electron'), [join(here, 'command-key-up-app.cjs')], {
    env: { ...process.env, PUDDLE_KEY_UP_TEST_DIRECTORY: directory },
    stdio: 'inherit',
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Native key-up check failed: ${result.status}`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
