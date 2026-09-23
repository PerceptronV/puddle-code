import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { standaloneInstallation } from '../src/lib/standalone-cli.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const installer = join(root, 'scripts/install-cli.sh');
const temps: string[] = [];
afterEach(() => {
  for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true });
});

function fixture() {
  const temp = mkdtempSync(join(tmpdir(), 'puddle-cli-installer-'));
  temps.push(temp);
  const home = join(temp, 'home');
  const prefix = join(home, '.local/share/puddle/cli');
  const launcher = join(home, '.local/bin/puddle');
  const stage = join(temp, 'stage/puddle-cli-v1.2.3');
  const tarball = join(temp, `puddle-cli-v1.2.3-${process.platform}-${process.arch}.tar.gz`);
  mkdirSync(home);
  mkdirSync(join(stage, 'cli/public'), { recursive: true });
  mkdirSync(join(stage, 'bin'));
  symlinkSync(process.execPath, join(stage, 'bin/node'));
  writeFileSync(join(stage, 'puddle'), '#!/bin/sh\nprintf "fixture CLI help\\n"\n', {
    mode: 0o755,
  });
  writeFileSync(join(stage, 'STANDALONE'), 'puddle-cli\n');
  writeFileSync(join(stage, 'VERSION'), '1.2.3\n');
  for (const file of [
    'index.js',
    'host-control.mjs',
    'public/index.html',
    'install.sh',
    'install-cli.sh',
  ])
    writeFileSync(join(stage, 'cli', file), 'fixture');
  const pack = () => {
    execFileSync('tar', ['-czf', tarball, '-C', join(temp, 'stage'), 'puddle-cli-v1.2.3']);
    const hash = createHash('sha256').update(readFileSync(tarball)).digest('hex');
    writeFileSync(`${tarball}.sha256`, `${hash}  ${tarball.split('/').pop()}\n`);
  };
  pack();
  const install = (args: string[] = []) =>
    execFileSync('sh', [installer, '--tarball', tarball, '--sums', `${tarball}.sha256`, ...args], {
      env: { HOME: home, PATH: process.env.PATH },
      encoding: 'utf8',
      stdio: 'pipe',
    });
  return { temp, home, prefix, launcher, stage, tarball, pack, install };
}

describe('standalone CLI installer', () => {
  it('retains immutable trees on reinstall and migrates owned legacy permissions', () => {
    const f = fixture();
    f.install();
    const previous = readlinkSync(join(f.prefix, 'current'));
    chmodSync(f.prefix, 0o755);
    f.install();
    expect(statSync(f.prefix).mode & 0o777).toBe(0o700);
    expect(readlinkSync(join(f.prefix, 'current'))).not.toBe(previous);
    expect(existsSync(join(f.prefix, previous, 'cli/public/index.html'))).toBe(true);
    expect(execFileSync(f.launcher, ['--help'], { encoding: 'utf8' })).toContain('fixture CLI');
  });

  it('rejects checksum failures before replacing a working installation', () => {
    const f = fixture();
    f.install();
    const previous = readlinkSync(join(f.prefix, 'current'));
    writeFileSync(`${f.tarball}.sha256`, `${'0'.repeat(64)}  ${f.tarball.split('/').pop()}\n`);
    expect(() => f.install()).toThrow('checksum mismatch');
    expect(readlinkSync(join(f.prefix, 'current'))).toBe(previous);
    expect(existsSync(join(f.prefix, '.install-lock'))).toBe(false);
  });

  it('rejects a missing checksum entry and incomplete or broken archives', () => {
    const f = fixture();
    f.install();
    const previous = readlinkSync(join(f.prefix, 'current'));
    writeFileSync(`${f.tarball}.sha256`, '');
    expect(() => f.install()).toThrow('missing or ambiguous checksum');
    writeFileSync(join(f.stage, 'puddle'), '#!/bin/sh\nexit 1\n');
    f.pack();
    expect(() => f.install()).toThrow('CLI smoke test failed');
    rmSync(join(f.stage, 'cli/public/index.html'));
    f.pack();
    expect(() => f.install()).toThrow('archive is missing');
    expect(readlinkSync(join(f.prefix, 'current'))).toBe(previous);
  });

  it('refuses an unrelated launcher, including a symlink, without overwriting it', () => {
    const f = fixture();
    mkdirSync(join(f.home, '.local/bin'), { recursive: true });
    writeFileSync(f.launcher, 'another installation');
    expect(() => f.install()).toThrow('Refusing to replace an unrelated launcher');
    expect(readFileSync(f.launcher, 'utf8')).toBe('another installation');
    rmSync(f.launcher);
    symlinkSync(join(f.stage, 'puddle'), f.launcher);
    expect(() => f.install()).toThrow('Refusing to replace an unrelated launcher');
    expect(readlinkSync(f.launcher)).toBe(join(f.stage, 'puddle'));
    expect(existsSync(join(f.prefix, 'current'))).toBe(false);
  });

  it('refuses unmanaged, symlinked or writable-by-others installation roots', () => {
    const f = fixture();
    writeFileSync(join(f.home, 'keep'), 'keep');
    expect(() => f.install(['--prefix', f.home])).toThrow('non-empty unmanaged');
    const alias = join(f.temp, 'alias');
    symlinkSync(f.home, alias);
    expect(() => f.install(['--prefix', alias])).toThrow('must not be a symlink');
    expect(() => f.install(['--prefix', `${alias}/`])).toThrow('must not be a symlink');
    chmodSync(f.home, 0o777);
    expect(() => f.install(['--prefix', f.home])).toThrow('not writable by others');
    expect(readFileSync(join(f.home, 'keep'), 'utf8')).toBe('keep');
  });

  it('rejects invalid versions and overlapping operations', () => {
    const f = fixture();
    expect(() => f.install(['--version', '../../outside'])).toThrow('invalid release version');
    f.install();
    mkdirSync(join(f.prefix, '.install-lock'));
    expect(() => f.install()).toThrow('another installer is running');
    expect(existsSync(join(f.prefix, '.install-lock'))).toBe(true);
  });

  it('does not treat an unmanaged standalone archive as an npm installation', () => {
    const f = fixture();
    expect(() => standaloneInstallation(join(f.stage, 'cli/index.js'))).toThrow(
      'not an installer-managed',
    );
    expect(standaloneInstallation(fileURLToPath(import.meta.url))).toBeNull();
  });
});

it('stages two canonical installers and the legacy daemon alias without runtime repository placeholders', () => {
  const f = fixture();
  const output = join(f.temp, 'public');
  execFileSync(process.execPath, [
    join(root, 'scripts/stage-installers.mjs'),
    output,
    'example/puddle',
  ]);
  for (const [name, source] of [
    ['install-cli.sh', 'install-cli.sh'],
    ['install-daemon.sh', 'install.sh'],
    ['install.sh', 'install.sh'],
  ]) {
    const script = readFileSync(join(output, name!), 'utf8');
    expect(script).toBe(
      readFileSync(join(root, 'scripts', source!), 'utf8').replaceAll('@@REPO@@', 'example/puddle'),
    );
    execFileSync('sh', ['-n'], { input: script });
    expect(script).not.toContain('@@REPO@@');
  }
});
