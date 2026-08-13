import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const INSTALLER = join(ROOT, 'scripts', 'install.sh');

describe('install.sh tree validation', () => {
  it('reinstalls an existing tree that no longer passes its smoke test', () => {
    const temp = mkdtempSync(join(tmpdir(), 'puddle-install-script-'));
    const home = join(temp, 'home');
    const puddleHome = join(home, '.puddle');
    const staged = join(temp, 'stage', 'puddled-v1.2.3');
    const tarball = join(temp, 'puddled-v1.2.3-linux-x64.tar.gz');
    mkdirSync(staged, { recursive: true });
    mkdirSync(home, { recursive: true });
    const stagedBinary = join(staged, 'puddled');
    writeFileSync(stagedBinary, '#!/bin/sh\nprintf "puddled 1.2.3\\n"\n');
    chmodSync(stagedBinary, 0o755);
    execFileSync('tar', ['-czf', tarball, '-C', join(temp, 'stage'), 'puddled-v1.2.3']);

    const install = () =>
      execFileSync(
        'sh',
        [INSTALLER, '--version', '1.2.3', '--tarball', tarball, '--no-supervisor'],
        { env: { ...process.env, HOME: home, PUDDLE_HOME: puddleHome }, encoding: 'utf8' },
      );

    install();
    expect(readFileSync(join(puddleHome, 'supervisor'), 'utf8')).toBe('none\n');

    const installed = join(puddleHome, 'bin', 'versions', '1.2.3', 'puddled');
    writeFileSync(installed, '#!/bin/sh\nexit 1\n');
    chmodSync(installed, 0o755);
    const output = install();

    expect(output).toContain('existing version 1.2.3 failed validation — reinstalling');
    expect(execFileSync(installed, ['--version'], { encoding: 'utf8' })).toBe('puddled 1.2.3\n');
  });
});
