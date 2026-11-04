import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { hostInstallationFixture as fixture } from '../../helpers/host-installation.js';

it('serialises competing installers before either can publish a generation', async () => {
  const f = fixture();
  const gate = join(f.temp, 'continue');
  const entered = join(f.temp, 'entered');
  writeFileSync(
    f.stagedBinary,
    '#!/bin/sh\ntouch "$INSTALL_ENTERED"\nwhile [ ! -e "$INSTALL_GATE" ]; do sleep 0.1; done\n',
  );
  f.pack();
  const first = promisify(execFile)('sh', f.args, {
    env: { ...f.env, INSTALL_ENTERED: entered, INSTALL_GATE: gate },
    timeout: 10_000,
  });
  try {
    await vi.waitFor(() => expect(existsSync(entered)).toBe(true));
    expect(f.install).toThrow('another installer is running');
    expect(existsSync(join(f.puddleHome, 'bin', 'current'))).toBe(false);
  } finally {
    writeFileSync(gate, 'continue');
    await first;
  }
  expect(f.generations()).toHaveLength(1);
  expect(statSync(join(f.puddleHome, 'bin', '.install-lock')).isFile()).toBe(true);
});

it('keeps exclusion after installer SIGKILL until its surviving smoke child exits', async () => {
  const f = fixture();
  const gate = join(f.temp, 'finish-child');
  const entered = join(f.temp, 'child-entered');
  writeFileSync(
    f.stagedBinary,
    '#!/bin/sh\ntouch "$INSTALL_ENTERED"\nwhile [ ! -e "$INSTALL_GATE" ]; do sleep 0.1; done\n',
  );
  f.pack();
  const childEnv = { ...f.env, INSTALL_ENTERED: entered, INSTALL_GATE: gate };
  const first = spawn('/bin/sh', f.args, { env: childEnv, stdio: 'ignore' });
  const exited = once(first, 'exit');
  try {
    await vi.waitFor(() => expect(existsSync(entered)).toBe(true), { timeout: 5000 });
    first.kill('SIGKILL');
    expect(await exited).toEqual([null, 'SIGKILL']);
    expect(f.install).toThrow('another installer is running');
    expect(existsSync(join(f.puddleHome, 'bin/current'))).toBe(false);
  } finally {
    writeFileSync(gate, 'finish');
    if (first.exitCode === null && first.signalCode === null) first.kill('SIGKILL');
    await exited;
    await vi.waitFor(
      () =>
        expect(() => f.install('--tarball', join(f.temp, 'missing.tar.gz'))).toThrow(
          'tarball not found',
        ),
      { timeout: 10_000 },
    );
  }
  // The interrupted generation is retained; a fresh attempt acquires the same inode.
  const inode = statSync(join(f.puddleHome, 'bin/.install-lock')).ino;
  writeFileSync(f.stagedBinary, '#!/bin/sh\nprintf "puddled 1.2.3\\n"\n');
  f.pack();
  await vi.waitFor(() => expect(f.install()).toContain('installed'), { timeout: 5000 });
  expect(statSync(join(f.puddleHome, 'bin/.install-lock')).ino).toBe(inode);
  expect(existsSync(join(f.selected(), 'puddled'))).toBe(true);
});

it.each(['legacy', 'symlink', 'hardlink', 'writable', 'content'] as const)(
  'refuses an ambiguous %s lock without deleting or replacing it',
  (kind) => {
    const f = fixture();
    mkdirSync(join(f.puddleHome, 'bin'), { recursive: true, mode: 0o700 });
    const lock = join(f.puddleHome, 'bin/.install-lock');
    const target = join(f.temp, 'keep');
    writeFileSync(target, '', { mode: 0o600 });
    if (kind === 'legacy') mkdirSync(lock);
    else if (kind === 'symlink') symlinkSync(target, lock);
    else if (kind === 'hardlink') linkSync(target, lock);
    else {
      writeFileSync(lock, kind === 'content' ? 'keep' : '', { mode: 0o600 });
      if (kind === 'writable') chmodSync(lock, 0o666);
    }
    expect(f.install).toThrow();
    expect(existsSync(lock)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('');
    expect(existsSync(join(f.puddleHome, 'bin/current'))).toBe(false);
  },
);
