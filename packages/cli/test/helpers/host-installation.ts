import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach } from 'vitest';
import type { Transport } from '../../src/lib/transport/transport.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const INSTALLER = join(ROOT, 'scripts', 'install.sh');
const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

export function hostInstallationFixture(homeName = 'home') {
  const temp = mkdtempSync(join(tmpdir(), 'puddle-install-script-'));
  temporary.push(temp);
  const home = join(temp, homeName);
  const puddleHome = join(home, '.puddle');
  const staged = join(temp, 'stage', 'puddled-v1.2.3');
  const tarball = join(temp, 'puddled-v1.2.3-linux-x64.tar.gz');
  mkdirSync(join(staged, 'bin'), { recursive: true });
  mkdirSync(home, { recursive: true });
  const stagedBinary = join(staged, 'puddled');
  writeFileSync(stagedBinary, '#!/bin/sh\nprintf "puddled 1.2.3\\n"\n');
  chmodSync(stagedBinary, 0o755);
  writeFileSync(
    join(staged, 'puddler'),
    '#!/bin/sh\nprintf "puddler 1.2.3 (runtime protocol 1.0)\\n"\n',
    { mode: 0o755 },
  );
  writeFileSync(join(staged, 'RUNTIME_PROTOCOL'), '1.0\n');
  symlinkSync(process.execPath, join(staged, 'bin', 'node'));
  writeFileSync(join(staged, 'VERSION'), '1.2.3\n');
  const pack = () =>
    execFileSync('tar', ['-czf', tarball, '-C', join(temp, 'stage'), 'puddled-v1.2.3']);
  pack();
  const env = { HOME: home, PUDDLE_HOME: puddleHome, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  const args = [
    '-c',
    'umask 022; exec sh "$@"',
    'install-test',
    INSTALLER,
    '--version',
    '1.2.3',
    '--tarball',
    tarball,
    '--no-supervisor',
  ];

  const install = (...extra: string[]) =>
    execFileSync(
      'sh',
      // Pin the caller's ordinary umask: fresh installs must not depend on it.
      [...args, ...extra],
      { env, encoding: 'utf8', stdio: 'pipe' },
    );
  const selected = (component: 'daemon' | 'runtime' = 'daemon') =>
    join(
      puddleHome,
      'bin',
      readlinkSync(join(puddleHome, 'bin', component === 'daemon' ? 'current' : 'runtime-current')),
    );
  const generations = () => readdirSync(join(puddleHome, 'bin', 'versions'));
  const transport: Transport = {
    kind: 'local',
    label: 'isolated fixture',
    async exec(command, options) {
      try {
        const pending = promisify(execFile)('sh', ['-c', command], { env, cwd: home });
        pending.child.stdin?.end(options?.stdin);
        const result = await pending;
        return { ...result, code: 0 };
      } catch (error) {
        const result = error as { code: number; stdout: string; stderr: string };
        return result;
      }
    },
    readFile: () => Promise.resolve(null),
    async copyTo(source, destination) {
      const target = join(home, destination);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
    },
    dispose() {},
  };
  return {
    temp,
    puddleHome,
    staged,
    stagedBinary,
    pack,
    install,
    selected,
    generations,
    args,
    env,
    transport,
    tarball,
  };
}
