import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { ipcPath } from '@puddle/shared/node';
import { acceptedCheckpointUpdate } from '../../daemon/test/helpers/update-checkpoint.js';
import { shellQuote } from '../src/lib/transport/ssh.js';
import { root } from './helpers.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture() {
  const temporary = mkdtempSync(join(tmpdir(), 'puddle-update-offline-'));
  cleanups.push(() => rmSync(temporary, { recursive: true, force: true }));
  const client = join(temporary, 'client');
  const target = join(temporary, 'target');
  const bin = join(temporary, 'bin');
  for (const directory of [client, target, bin]) mkdirSync(directory);
  const home = join(target, '.puddle');
  const { operation } = acceptedCheckpointUpdate(home);
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
  return { home, operation, run, ledger: join(home, 'updates/operations.json') };
}

it.each(['local', 'ssh'] as const)(
  'inspects interrupted updates through the built %s CLI without a daemon or application database',
  async (kind) => {
    const f = fixture();
    const before = readFileSync(f.ledger);
    const args = [
      'updates',
      ...(kind === 'ssh' ? ['user@fixture'] : []),
      '--operation',
      f.operation.id,
    ];
    const result = await f.run('index.js', args, '', kind === 'local');
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toContain('showing recorded update state');
    expect(result.stdout + result.stderr).toContain(f.operation.id);
    expect(result.stdout + result.stderr).toContain('dispatching');
    for (const action of ['--cancel', '--recover']) {
      const rejected = await f.run('index.js', [...args, action], '', kind === 'local');
      expect(rejected.code).not.toBe(0);
      expect(rejected.stdout + rejected.stderr).not.toContain('showing recorded update state');
    }
    expect(readFileSync(f.ledger)).toEqual(before);
    for (const name of ['puddle.db', 'runtime.json', 'token', 'supervisor'])
      expect(existsSync(join(f.home, name))).toBe(false);
  },
);

it('bounds the bootstrap helper input and refuses mutation or fresh-adoption requests', async () => {
  const f = fixture();
  const before = readFileSync(f.ledger);
  const request_id = randomUUID();
  for (const command of [
    {
      action: 'recover',
      reference: { id: f.operation.id, revision: f.operation.revision },
      strategy: 'verify-completion',
    },
    { action: 'status', id: f.operation.id, adoption_nonce: randomUUID() },
  ]) {
    const result = await f.run(
      'host-control.mjs',
      ['--updates'],
      JSON.stringify({ t: 'host-update', request_id, command }),
      true,
    );
    expect(JSON.parse(result.stdout)).toEqual({
      t: 'host-update-result',
      request_id,
      result: { ok: false, code: 'unsupported', operation: null },
    });
  }
  for (const input of ['{', ' '.repeat(16 * 1024 + 1)]) {
    const result = await f.run('host-control.mjs', ['--updates'], input, true);
    expect(JSON.parse(result.stdout)).toEqual({ t: 'error', code: 'rejected' });
  }
  expect(readFileSync(f.ledger)).toEqual(before);
});
