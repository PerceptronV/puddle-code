import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { hostReleaseCapabilities } from '@puddle/shared';
import { readStageCapabilities } from '../../../src/updates/preflight/candidate.js';
import { candidateFixture } from './helpers.js';

it('reads a verified candidate without executing its daemon', async () => {
  const f = candidateFixture();
  writeFileSync(join(f.root, 'puddled'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  expect(await readStageCapabilities(f.home, f.stage)).toEqual(f.capabilities);
  expect(f.capabilities.supported_runtime_majors).toEqual([1]);
  expect(f.capabilities).not.toHaveProperty('runtime_readers');
});

it('allows development build labels without changing the runtime compatibility contract', () => {
  expect(hostReleaseCapabilities('development-build').supported_runtime_majors).toEqual([1]);
});

it('rejects a generation redirected to another installation tree', async () => {
  const f = candidateFixture();
  renameSync(f.root, `${f.root}-other`);
  symlinkSync(`${f.root}-other`, f.root);
  await expect(readStageCapabilities(f.home, f.stage)).rejects.toThrow(
    'exact installed generation',
  );
});

it.each([
  'missing',
  'oversized',
  'symlink',
  'directory',
  'version',
  'protocol',
  'database',
  'receipt',
])('refuses %s candidate metadata without probing an executable', async (failure) => {
  const f = candidateFixture();
  const path = join(f.root, 'HOST_CAPABILITIES.json');
  if (failure === 'missing') rmSync(path);
  if (failure === 'oversized') writeFileSync(path, ' '.repeat(32769));
  if (failure === 'symlink') {
    rmSync(path);
    symlinkSync('/missing/capabilities', path);
  }
  if (failure === 'directory') {
    rmSync(path);
    mkdirSync(path);
  }
  if (failure === 'version') writeFileSync(path, JSON.stringify(hostReleaseCapabilities('0.4.1')));
  if (failure === 'protocol')
    writeFileSync(
      path,
      JSON.stringify({ ...f.capabilities, application: { major: 999, minor: 0 } }),
    );
  if (failure === 'database')
    writeFileSync(path, JSON.stringify({ ...f.capabilities, database_schema_version: -1 }));
  if (failure === 'receipt') writeFileSync(join(f.root, '.puddle-stage.json'), '{}');
  await expect(readStageCapabilities(f.home, f.stage)).rejects.toThrow();
});
