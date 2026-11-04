import { chmodSync, existsSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { hostInstallationFixture } from '../../helpers/host-installation.js';
import { hasPersistentHostInstallation } from '../../../src/lib/installation/host/presence.js';

it.each(['daemon', 'runtime'] as const)(
  'refuses %s installation during removal, preserving the existing selector and release',
  async (component) => {
    const f = hostInstallationFixture();
    f.install('--component', component);
    const previous = f.selected(component);
    const generations = f.generations();
    const directory = join(f.puddleHome, 'installation/removal');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const record = join(directory, 'services.json');
    writeFileSync(record, '{', { mode: 0o600 });
    expect(() => f.install('--component', component)).toThrow(/recorded host removal/);
    expect(f.selected(component)).toBe(previous);
    expect(f.generations()).toEqual(generations);
    renameSync(record, join(directory, 'cancelled-services.json'));
    expect(f.install('--component', component)).toContain('installed');
    expect(existsSync(previous)).toBe(true);
  },
);

it('recognises a removal-only host as modern without falling back to bootstrap', async () => {
  const f = hostInstallationFixture();
  expect(await hasPersistentHostInstallation(f.transport)).toBe(false);
  const directory = join(f.puddleHome, 'installation/removal');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  symlinkSync(join(f.temp, 'missing'), join(directory, 'services.json'));
  expect(await hasPersistentHostInstallation(f.transport)).toBe(true);
  expect(() => f.install()).toThrow(/recorded host removal/);
  expect(f.generations()).toEqual([]);
});

it.each(['shared', 'linked'] as const)(
  'refuses an unsafe %s removal parent before installing',
  (kind) => {
    const f = hostInstallationFixture();
    const directory = join(f.puddleHome, 'installation');
    mkdirSync(f.puddleHome, { recursive: true, mode: 0o700 });
    if (kind === 'linked') symlinkSync(join(f.temp, 'missing'), directory);
    else {
      mkdirSync(directory, { mode: 0o700 });
      chmodSync(directory, 0o755);
    }
    expect(() => f.install()).toThrow(/unsafe host removal directory/);
    expect(f.generations()).toEqual([]);
  },
);
