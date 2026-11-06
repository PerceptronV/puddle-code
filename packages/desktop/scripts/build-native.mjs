import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Stable Node-API, with both Mac architectures; Linux needs no native shim. */
export function buildNative(outputDirectory) {
  if (process.platform !== 'darwin') return;
  mkdirSync(outputDirectory, { recursive: true });
  const headers = require('node-api-headers').include_dir;
  execFileSync(
    'xcrun',
    [
      'clang',
      '-bundle',
      '-undefined',
      'dynamic_lookup',
      '-fobjc-arc',
      '-arch',
      'arm64',
      '-arch',
      'x86_64',
      '-mmacosx-version-min=12.0',
      '-framework',
      'AppKit',
      '-I',
      headers,
      join(root, 'native/command-key-up.m'),
      '-o',
      join(outputDirectory, 'command-key-up.node'),
    ],
    { stdio: 'inherit' },
  );
}
