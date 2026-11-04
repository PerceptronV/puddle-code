import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, onTestFinished, vi } from 'vitest';
import { acquireInstallationLock } from '../../../src/host/installation/lock.js';
import { runCompilationCommand } from '../../../src/compilation/process.js';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'puddle-install-claim-'));
  onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, 'bin'), { mode: 0o700 });
  return { home, file: join(home, 'bin/.install-lock') };
}

it('shares a permanent lock inode with the shell installer and fences legacy mkdir', () => {
  const f = fixture();
  const lock = acquireInstallationLock(f.home);
  const inode = statSync(f.file).ino;
  const installer = fileURLToPath(new URL('../../../../../scripts/install.sh', import.meta.url));
  const install = () =>
    execFileSync(
      '/bin/sh',
      [installer, '--version', '0.4.0', '--tarball', '/missing-fixture.tar.gz', '--no-supervisor'],
      {
        env: { HOME: f.home, PUDDLE_HOME: f.home, PATH: '/usr/bin:/bin' },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
      },
    );
  try {
    expect(() => acquireInstallationLock(f.home)).toThrow('Another installer');
    expect(() => mkdirSync(f.file)).toThrow();
    expect(install).toThrow('another installer is running');
  } finally {
    lock.release();
  }
  expect(install).toThrow('tarball not found');
  acquireInstallationLock(f.home).release();
  expect(statSync(f.file).ino).toBe(inode);
  expect(readFileSync(f.file).length).toBe(0);
});

it.each(['legacy', 'symlink', 'hardlink', 'writable', 'content'] as const)(
  'does not replace an ambiguous %s lock',
  (kind) => {
    const f = fixture();
    const target = join(f.home, 'keep');
    writeFileSync(target, '', { mode: 0o600 });
    if (kind === 'legacy') mkdirSync(f.file);
    else if (kind === 'symlink') symlinkSync(target, f.file);
    else if (kind === 'hardlink') linkSync(target, f.file);
    else {
      writeFileSync(f.file, kind === 'content' ? 'keep' : '', { mode: 0o600 });
      if (kind === 'writable') chmodSync(f.file, 0o666);
    }
    expect(() => acquireInstallationLock(f.home)).toThrow();
    expect(existsSync(f.file)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('');
  },
);

it('retains exclusion in command children after the parent closes its descriptor', async () => {
  const f = fixture();
  const lock = acquireInstallationLock(f.home);
  const ready = join(f.home, 'ready');
  const gate = join(f.home, 'finish');
  const child = runCompilationCommand({
    file: process.execPath,
    args: [
      '--input-type=module',
      '-e',
      `import fs from 'node:fs';
if (!fs.fstatSync(3).isFile()) throw Error('Lock descriptor missing');
fs.writeFileSync(process.argv[1], 'ready');
const timer=setInterval(()=>{if(fs.existsSync(process.argv[2])){clearInterval(timer);}},10);`,
      ready,
      gate,
    ],
    cwd: f.home,
    env: { PATH: '/usr/bin:/bin' },
    inheritedFds: [lock.descriptor],
    timeoutMs: 5000,
  });
  // Attach rejection handling before waiting for readiness, so startup failures stay local.
  const result = child.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  const finish = async () => {
    lock.release();
    writeFileSync(gate, 'finish');
    const ended = await result;
    if ('error' in ended) throw ended.error;
  };
  try {
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true));
    lock.release();
    expect(() => acquireInstallationLock(f.home)).toThrow('Another installer');
  } finally {
    await finish();
  }
  acquireInstallationLock(f.home).release();
});
