import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { hostReleaseCapabilities } from '@puddle/shared';
import { readStageCapabilities } from '@puddle/shared/node/host-control';
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

it('reads daemon role support separately and leaves historical host metadata compatible', async () => {
  const { daemonRuntimeCapabilities } = await import('@puddle/shared');
  const { readStageDaemonRuntimeCapabilities } = await import('@puddle/shared/node/host-control');
  const f = candidateFixture();
  expect(await readStageDaemonRuntimeCapabilities(f.home, f.stage)).toBeNull();
  const value = daemonRuntimeCapabilities(f.capabilities.version);
  writeFileSync(join(f.root, 'DAEMON_RUNTIME_CAPABILITIES.json'), JSON.stringify(value));
  expect(await readStageDaemonRuntimeCapabilities(f.home, f.stage)).toEqual(value);
  expect(await readStageCapabilities(f.home, f.stage)).toEqual(f.capabilities);
});

it.each(['version', 'protocol', 'oversized', 'symlink', 'directory', 'contract', 'receipt'])(
  'refuses %s daemon role metadata without executing a candidate',
  async (failure) => {
    const { daemonRuntimeCapabilities } = await import('@puddle/shared');
    const { readStageDaemonRuntimeCapabilities } = await import('@puddle/shared/node/host-control');
    const f = candidateFixture();
    const file = join(f.root, 'DAEMON_RUNTIME_CAPABILITIES.json');
    const value = daemonRuntimeCapabilities(f.capabilities.version);
    if (failure === 'version') value.version = 'different';
    if (failure === 'protocol') value.application.minor++;
    if (failure === 'contract') value.roles.huddle!.owner = 0;
    writeFileSync(file, failure === 'oversized' ? ' '.repeat(32769) : JSON.stringify(value));
    if (failure === 'symlink') {
      renameSync(file, `${file}.other`);
      symlinkSync(`${file}.other`, file);
    }
    if (failure === 'directory') {
      rmSync(file);
      mkdirSync(file);
    }
    if (failure === 'receipt') writeFileSync(join(f.root, '.puddle-stage.json'), '{}');
    await expect(readStageDaemonRuntimeCapabilities(f.home, f.stage)).rejects.toThrow();
  },
);
