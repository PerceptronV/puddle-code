import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { installedVersion, installHostComponent } from '../../src/lib/installation/bootstrap.js';
import {
  installedComponentVersions,
  formatComponentVersions,
} from '../../src/lib/installation/component-versions.js';

import { hostInstallationFixture as fixture } from '../helpers/host-installation.js';

describe('install.sh tree validation', () => {
  it('initialises the mandatory runtime default during a daemon-only first install', () => {
    const f = fixture();
    f.install();
    expect(f.selected('runtime')).toBe(f.selected());
    expect(
      execFileSync(join(f.puddleHome, 'bin/puddler'), ['--version'], {
        env: f.env,
        encoding: 'utf8',
      }),
    ).toContain('puddler 1.2.3 (runtime protocol 1.0)');
  });

  it('upgrades a legacy daemon-only layout with a first runtime default and retains its old tree', () => {
    const f = fixture();
    const legacy = join(f.puddleHome, 'bin/versions/0.3.14');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'puddled'), '#!/bin/sh\nprintf "puddled 0.3.14\\n"\n', {
      mode: 0o755,
    });
    symlinkSync('versions/0.3.14', join(f.puddleHome, 'bin/current'));
    expect(existsSync(join(f.puddleHome, 'bin/runtime-current'))).toBe(false);
    f.install();
    expect(f.selected()).not.toBe(legacy);
    expect(f.selected('runtime')).toBe(f.selected());
    expect(existsSync(join(legacy, 'puddled'))).toBe(true);
    expect(
      execFileSync(join(f.puddleHome, 'bin/puddler'), ['--version'], {
        env: f.env,
        encoding: 'utf8',
      }),
    ).toContain('runtime protocol 1.0');
  });

  it('preserves an independently selected runtime when repairing the daemon generation', () => {
    const f = fixture();
    f.install();
    const runtime = f.selected('runtime');
    const wrapper = readFileSync(join(f.puddleHome, 'bin/puddler'), 'utf8');
    f.install('--force');
    expect(f.selected()).not.toBe(runtime);
    expect(f.selected('runtime')).toBe(runtime);
    expect(readFileSync(join(f.puddleHome, 'bin/puddler'), 'utf8')).toBe(wrapper);
    expect(existsSync(join(runtime, 'puddler'))).toBe(true);
  });

  it.each(['missing', 'broken'] as const)(
    'rejects a %s initial runtime before changing the daemon selector',
    (kind) => {
      const f = fixture();
      f.install();
      const daemon = f.selected();
      rmSync(join(f.puddleHome, 'bin/runtime-current'));
      rmSync(join(f.puddleHome, 'bin/puddler'));
      if (kind === 'missing') rmSync(join(f.staged, 'puddler'));
      else writeFileSync(join(f.staged, 'puddler'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      f.pack();
      expect(() => f.install('--force')).toThrow('initial runtime fails');
      expect(f.selected()).toBe(daemon);
      expect(existsSync(join(f.puddleHome, 'bin/runtime-current'))).toBe(false);
      expect(existsSync(join(daemon, 'puddler'))).toBe(true);
    },
  );

  it('retains and reuses the runtime-selected generation when daemon selector publication fails', () => {
    const f = fixture();
    const current = join(f.puddleHome, 'bin/current');
    mkdirSync(current, { recursive: true });
    writeFileSync(join(current, 'do-not-overwrite'), 'retained');
    const data = join(f.puddleHome, 'fixture-data');
    writeFileSync(data, 'untouched user data');
    expect(() => f.install()).toThrow('current must be a symlink');
    const runtime = f.selected('runtime');
    expect(existsSync(join(runtime, 'puddler'))).toBe(true);
    expect(readFileSync(join(current, 'do-not-overwrite'), 'utf8')).toBe('retained');
    expect(
      execFileSync(join(f.puddleHome, 'bin/puddler'), ['--version'], {
        env: f.env,
        encoding: 'utf8',
      }),
    ).toContain('runtime protocol 1.0');
    rmSync(current, { recursive: true });
    f.install();
    expect(f.selected()).toBe(runtime);
    expect(f.selected('runtime')).toBe(runtime);
    expect(f.generations()).toHaveLength(1);
    expect(readFileSync(data, 'utf8')).toBe('untouched user data');
  });

  it('rejects a modern archive with capabilities but no initial runtime files', () => {
    const f = fixture();
    rmSync(join(f.staged, 'puddler'));
    rmSync(join(f.staged, 'RUNTIME_PROTOCOL'));
    writeFileSync(join(f.staged, 'HOST_CAPABILITIES.json'), '{}\n');
    f.pack();
    expect(() => f.install()).toThrow('initial runtime fails');
    expect(existsSync(join(f.puddleHome, 'bin/current'))).toBe(false);
    expect(existsSync(join(f.puddleHome, 'bin/runtime-current'))).toBe(false);
  });

  it('retains bootstrap support for historical daemon archives without runtime metadata', () => {
    const f = fixture();
    for (const name of ['puddler', 'RUNTIME_PROTOCOL', 'HOST_CAPABILITIES.json']) {
      rmSync(join(f.staged, name), { force: true });
    }
    f.pack();
    f.install();
    expect(existsSync(join(f.selected(), 'puddled'))).toBe(true);
    expect(existsSync(join(f.puddleHome, 'bin/runtime-current'))).toBe(false);
    expect(existsSync(join(f.puddleHome, 'bin/puddler'))).toBe(false);
  });

  it('creates a private home with an ordinary caller umask', () => {
    const { puddleHome, install } = fixture();
    install();
    expect(statSync(puddleHome).mode & 0o777).toBe(0o700);
  });

  it('migrates legacy home permissions on reinstall without changing existing data', () => {
    const { puddleHome, install } = fixture();
    install();
    const data = join(puddleHome, 'puddle.db');
    writeFileSync(data, 'existing session data');
    chmodSync(data, 0o640);
    chmodSync(puddleHome, 0o755);
    expect(install()).toContain('version 1.2.3 already installed');
    expect(statSync(puddleHome).mode & 0o777).toBe(0o700);
    expect(readFileSync(data, 'utf8')).toBe('existing session data');
    expect(statSync(data).mode & 0o777).toBe(0o640);
  });

  it('replaces a legacy writable supervision marker with a private file', () => {
    const f = fixture();
    f.install();
    const marker = join(f.puddleHome, 'supervisor');
    chmodSync(marker, 0o664);
    f.install('--force');
    expect(readFileSync(marker, 'utf8')).toBe('none\n');
    expect(statSync(marker).mode & 0o777).toBe(0o600);
  });

  it('refuses a symlinked home without changing its target', () => {
    const { temp, puddleHome, install } = fixture();
    const target = join(temp, 'target');
    mkdirSync(target);
    chmodSync(target, 0o755);
    symlinkSync(target, puddleHome);
    expect(install).toThrow('must not be a symlink');
    expect(statSync(target).mode & 0o777).toBe(0o755);
  });

  it('refuses a home writable by other users', () => {
    const { puddleHome, install } = fixture();
    mkdirSync(puddleHome);
    chmodSync(puddleHome, 0o777);
    expect(install).toThrow('must not be writable by other users');
    expect(statSync(puddleHome).mode & 0o777).toBe(0o777);
  });

  it('reinstalls an existing tree that no longer passes its smoke test', () => {
    const { puddleHome, install, selected } = fixture();
    install();
    expect(readFileSync(join(puddleHome, 'supervisor'), 'utf8')).toBe('none\n');

    const installed = join(selected(), 'puddled');
    writeFileSync(installed, '#!/bin/sh\nexit 1\n');
    chmodSync(installed, 0o755);
    const output = install();

    expect(output).toContain('existing version 1.2.3 failed validation — staging a new generation');
    expect(readFileSync(installed, 'utf8')).toBe('#!/bin/sh\nexit 1\n');
    expect(join(selected(), 'puddled')).not.toBe(installed);
    expect(execFileSync(join(selected(), 'puddled'), ['--version'], { encoding: 'utf8' })).toBe(
      'puddled 1.2.3\n',
    );
  });

  it('retains published files on forced repair and reuses a healthy selected generation', async () => {
    const f = fixture();
    f.install();
    const previous = f.selected();
    const oldBinary = readFileSync(join(previous, 'puddled'), 'utf8');
    f.install();
    expect(f.selected()).toBe(previous);
    f.install('--force');
    expect(f.selected()).not.toBe(previous);
    expect(readFileSync(join(previous, 'puddled'), 'utf8')).toBe(oldBinary);
    expect(f.generations()).toHaveLength(2);
    expect(await installedVersion(f.transport)).toBe('1.2.3');
    const inventory = await installedComponentVersions({ home: f.puddleHome, platform: 'linux' });
    expect(inventory[1]).toMatchObject({ installed: true, version: '1.2.3' });
    expect(
      execFileSync(join(f.puddleHome, 'bin', 'puddled'), ['--version'], {
        env: f.env,
        encoding: 'utf8',
      }),
    ).toBe('puddled 1.2.3\n');
  });

  it('preserves literal home paths in the atomic launcher wrapper', () => {
    const f = fixture("home with 'quotes' and $variables");
    f.install();
    expect(
      execFileSync(join(f.puddleHome, 'bin', 'puddled'), ['--version'], {
        env: f.env,
        encoding: 'utf8',
      }),
    ).toBe('puddled 1.2.3\n');
  });

  it('selects and inventories runtime software independently through the shared bootstrap', async () => {
    const f = fixture();
    f.install();
    const daemon = f.selected();
    const marker = join(f.puddleHome, 'supervisor');
    writeFileSync(marker, 'launchd\n');
    // A runtime update must not execute the daemon, even its version probe.
    writeFileSync(f.stagedBinary, '#!/bin/sh\nexit 99\n');
    writeFileSync(join(daemon, 'puddled'), '#!/bin/sh\nexit 99\n');
    f.pack();
    await installHostComponent(f.transport, 'runtime', { version: '1.2.3', tarball: f.tarball });
    const runtime = f.selected('runtime');
    expect(runtime).toBe(daemon); // Share an already staged build, with independent selectors.
    expect(f.selected()).toBe(daemon);
    expect(readFileSync(marker, 'utf8')).toBe('launchd\n');
    expect(await installedVersion(f.transport, 'runtime')).toBe('1.2.3');
    const components = await installedComponentVersions({ home: f.puddleHome, platform: 'linux' });
    expect(components[3]).toEqual({
      component: 'runtime',
      installed: true,
      version: '1.2.3',
      protocol: { major: 1, minor: 0 },
    });
    expect(formatComponentVersions(components)).toContain('runtime 1.2.3 (runtime protocol 1.0)');
    expect(
      execFileSync(join(f.puddleHome, 'bin', 'puddler'), ['--version'], {
        env: f.env,
        encoding: 'utf8',
      }),
    ).toContain('runtime protocol 1.0');
    f.install('--component', 'runtime', '--force');
    expect(f.selected('runtime')).not.toBe(runtime);
    expect(f.selected()).toBe(daemon);
    expect(existsSync(join(runtime, 'puddler'))).toBe(true);
    // Restore a valid daemon archive and repair it independently too.
    writeFileSync(f.stagedBinary, '#!/bin/sh\nexit 0\n');
    f.pack();
    const selectedRuntime = f.selected('runtime');
    f.install('--force');
    expect(f.selected()).not.toBe(daemon);
    expect(f.selected('runtime')).toBe(selectedRuntime);
  });

  it('installs only a runtime selector on a fresh host and starts no service', async () => {
    const f = fixture();
    await installHostComponent(f.transport, 'runtime', { version: '1.2.3', tarball: f.tarball });
    expect(await installedVersion(f.transport)).toBeNull();
    expect(await installedVersion(f.transport, 'runtime')).toBe('1.2.3');
    expect(existsSync(join(f.puddleHome, 'supervisor'))).toBe(false);
    expect(existsSync(join(f.env.HOME, 'Library', 'LaunchAgents'))).toBe(false);
    expect(existsSync(join(f.puddleHome, 'bin', 'puddled'))).toBe(false);
  });

  it('keeps an older daemon selected when installing a newer runtime release', async () => {
    const f = fixture();
    f.install();
    const daemon = f.selected();
    writeFileSync(join(f.staged, 'VERSION'), '4.5.6\n');
    writeFileSync(
      join(f.staged, 'puddler'),
      '#!/bin/sh\nprintf "puddler 4.5.6 (runtime protocol 1.0)\\n"\n',
    );
    f.pack();
    await installHostComponent(f.transport, 'runtime', { version: '4.5.6', tarball: f.tarball });
    expect(f.selected()).toBe(daemon);
    expect(await installedVersion(f.transport)).toBe('1.2.3');
    expect(await installedVersion(f.transport, 'runtime')).toBe('4.5.6');
    const inventory = await installedComponentVersions({ home: f.puddleHome, platform: 'linux' });
    expect(inventory[1]?.version).toBe('1.2.3');
    expect(inventory[3]?.version).toBe('4.5.6');
  });

  it.each(['missing', 'invalid', 'mismatch'])(
    'preserves the previous runtime selection with %s runtime metadata',
    (failure) => {
      const f = fixture();
      f.install('--component', 'runtime');
      const previous = f.selected('runtime');
      if (failure === 'missing') rmSync(join(f.staged, 'RUNTIME_PROTOCOL'));
      else
        writeFileSync(
          join(f.staged, 'RUNTIME_PROTOCOL'),
          failure === 'invalid' ? '1.0\ngarbage' : '2.0\n',
        );
      f.pack();
      expect(() => f.install('--component', 'runtime', '--force')).toThrow('smoke test');
      expect(f.selected('runtime')).toBe(previous);
      expect(f.generations()).toHaveLength(1);
    },
  );

  it.each(['metadata', 'smoke', 'node'])(
    'preserves the selected release after a failed %s check',
    (failure) => {
      const f = fixture();
      f.install();
      const previous = f.selected();
      if (failure === 'metadata') writeFileSync(join(f.staged, 'VERSION'), '9.9.9\n');
      if (failure === 'smoke') writeFileSync(f.stagedBinary, '#!/bin/sh\nexit 1\n');
      if (failure === 'node') rmSync(join(f.staged, 'bin', 'node'));
      f.pack();
      expect(() => f.install('--force')).toThrow();
      expect(f.selected()).toBe(previous);
      expect(f.generations()).toHaveLength(1);
      expect(statSync(join(f.puddleHome, 'bin', '.install-lock')).isFile()).toBe(true);
    },
  );

  it('refuses an ordinary directory at current without replacing or deleting it', () => {
    const f = fixture();
    const current = join(f.puddleHome, 'bin', 'current');
    mkdirSync(current, { recursive: true });
    writeFileSync(join(current, 'keep'), 'existing files');
    expect(f.install).toThrow('current must be a symlink');
    expect(readFileSync(join(current, 'keep'), 'utf8')).toBe('existing files');
    expect(f.generations()).toHaveLength(1);
    expect(existsSync(join(f.selected('runtime'), 'puddler'))).toBe(true);
  });

  it('reads legacy selectors without starting a daemon and rejects corrupt generation metadata', async () => {
    const f = fixture();
    const legacy = join(f.puddleHome, 'bin', 'versions', '0.0.43');
    mkdirSync(legacy, { recursive: true });
    symlinkSync('versions/0.0.43', join(f.puddleHome, 'bin', 'current'));
    writeFileSync(join(legacy, 'puddled'), '#!/bin/sh\nexit 99\n');
    chmodSync(join(legacy, 'puddled'), 0o755);
    expect(await installedVersion(f.transport)).toBe('0.0.43');
    expect(
      (await installedComponentVersions({ home: f.puddleHome, platform: 'linux' }))[1],
    ).toMatchObject({ version: '0.0.43' });
    writeFileSync(join(legacy, 'VERSION'), 'not a release');
    expect(await installedVersion(f.transport)).toBeNull();
    expect(
      (await installedComponentVersions({ home: f.puddleHome, platform: 'linux' }))[1],
    ).toMatchObject({ installed: false });
    f.install('--force');
    rmSync(join(f.selected(), 'VERSION'));
    expect(await installedVersion(f.transport)).toBeNull();
    expect(existsSync(join(legacy, 'puddled'))).toBe(true);
  });
});

it('rejects selecting an excluded component even when its executable shares the host archive', () => {
  const f = fixture();
  writeFileSync(
    join(f.staged, 'release-manifest.json'),
    JSON.stringify({
      format: 1,
      version: '1.2.3',
      components: { cockpit: '1.2.3', daemon: '1.2.2', runtime: '1.2.3' },
    }),
  );
  f.pack();
  expect(() => f.install()).toThrow('No daemon was published');
  expect(existsSync(join(f.puddleHome, 'bin/current'))).toBe(false);
});

it('does not seed an unpublished runtime during selective daemon bootstrap', () => {
  const f = fixture();
  writeFileSync(
    join(f.staged, 'release-manifest.json'),
    JSON.stringify({
      format: 1,
      version: '1.2.3',
      components: { cockpit: '1.2.3', daemon: '1.2.3', runtime: '1.2.2' },
    }),
  );
  f.pack();
  expect(() => f.install()).toThrow('Install runtime 1.2.2');
  expect(existsSync(join(f.puddleHome, 'bin/current'))).toBe(false);
  expect(existsSync(join(f.puddleHome, 'bin/runtime-current'))).toBe(false);
});
