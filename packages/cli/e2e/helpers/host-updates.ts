import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach } from 'vitest';
import { ipcPath } from '@puddle/shared/node';
import { acceptedCheckpointUpdate } from '../../../daemon/test/helpers/update-checkpoint.js';
import { shellQuote } from '../../src/lib/transport/ssh.js';
import { root } from '../helpers.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

export function offlineUpdateFixture(protocol?: { major: number; minor: number }) {
  const temporary = mkdtempSync(join(tmpdir(), 'puddle-update-offline-'));
  cleanups.push(() => rmSync(temporary, { recursive: true, force: true }));
  const client = join(temporary, 'client');
  const target = join(temporary, 'target');
  const bin = join(temporary, 'bin');
  for (const directory of [client, target, bin]) mkdirSync(directory);
  const home = join(target, '.puddle');
  const { operation, store } = acceptedCheckpointUpdate(home, 'daemon', protocol);
  mkdirSync(join(home, 'bin/current/bin'), { recursive: true });
  symlinkSync(process.execPath, join(home, 'bin/current/bin/node'));
  writeFileSync(
    join(bin, 'ssh'),
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(root, 'packages/cli/test/helpers/fake-ssh.mjs'))} "$@"\n`,
    { mode: 0o755 },
  );
  const env = {
    HOME: client,
    PUDDLE_HOME: join(client, '.puddle'),
    FAKE_SSH_HOME: target,
    PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    SHELL: '/bin/sh',
    LANG: 'en_US.UTF-8',
  };
  const run = (entry: string, args: string[], input = '', local = false) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [join(root, 'packages/cli/dist', entry), ...args], {
        cwd: temporary,
        env: local ? { ...env, HOME: target, PUDDLE_HOME: home } : env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '',
        stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
      child.stdout.on('data', (data) => {
        stdout += String(data);
      });
      child.stderr.on('data', (data) => {
        stderr += String(data);
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  cleanups.push(() => rmSync(dirname(ipcPath(home, 'host')), { recursive: true, force: true }));
  return {
    home,
    operation,
    store,
    run,
    env,
    sshBinary: join(bin, 'ssh'),
    ledger: join(home, 'updates/operations.json'),
  };
}
