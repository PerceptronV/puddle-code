import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { digest } from '@puddle/shared/node';
import { updateWorkerExecutables } from '@puddle/shared/node/host-control';
import type { CompilationCommand } from '../../../src/compilation/process.js';
import { stageRemoteHostUpdate } from '../../../src/updates/remote/staging.js';
import { candidateFixture } from '../preflight/helpers.js';

function fixture() {
  const f = candidateFixture('runtime');
  mkdirSync(join(f.root, 'bin'));
  mkdirSync(join(f.root, 'daemon'));
  writeFileSync(join(f.root, 'bin/node'), '', { mode: 0o700 });
  writeFileSync(join(f.root, 'daemon/host-update.mjs'), '');
  writeFileSync(join(f.root, 'daemon/install.sh'), '');
  const output = `Installer progress\nPUDDLE_HOST_STAGE ${JSON.stringify(f.stage)}\n`;
  const run = vi.fn(async (_command: CompilationCommand) => ({
    exitCode: 0,
    stdout: output,
    stderr: '',
  }));
  let allowed = true;
  const stage = (repository = 'private-owner/host-release') =>
    stageRemoteHostUpdate(f.home, f.root, repository, f.operation.targets[0]!, () => allowed, run);
  return {
    ...f,
    run,
    output,
    stageRemote: stage,
    revoke: () => {
      allowed = false;
    },
  };
}

it('uses the host-owned repository and pinned installer through one bounded command with a clean environment', async () => {
  const f = fixture();
  expect(await f.stageRemote()).toEqual(f.stage);
  const pinned = updateWorkerExecutables(f.home, f.root);
  expect(f.run).toHaveBeenCalledExactlyOnceWith({
    file: '/bin/sh',
    args: [
      pinned.installer_path,
      '--repo',
      'private-owner/host-release',
      '--version',
      '0.4.0',
      '--component',
      'runtime',
      '--stage-only',
    ],
    cwd: f.home,
    env: {
      HOME: homedir(),
      PUDDLE_HOME: f.home,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      LANG: 'en_US.UTF-8',
    },
    timeoutMs: 120_000,
    maxOutputBytes: 256 * 1024,
  });
});

it.each(['https://attacker.invalid/releases', '../outside', 'owner/repo;echo stolen', 'owner/..'])(
  'rejects an invalid repository %s before executing anything',
  async (repository) => {
    const f = fixture();
    await expect(f.stageRemote(repository)).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
  },
);

it('refuses an installer symlink outside the pinned generation', async () => {
  const f = fixture();
  const outside = join(f.home, 'another-installer.sh');
  writeFileSync(outside, '');
  rmSync(join(f.root, 'daemon/install.sh'));
  symlinkSync(outside, join(f.root, 'daemon/install.sh'));
  await expect(f.stageRemote()).rejects.toThrow('not pinned');
  expect(f.run).not.toHaveBeenCalled();
});

it('rejects authority loss before dispatch and after successful asynchronous staging', async () => {
  const before = fixture();
  before.revoke();
  await expect(before.stageRemote()).rejects.toThrow('authority expired');
  expect(before.run).not.toHaveBeenCalled();
  const after = fixture();
  after.run.mockImplementationOnce(async () => {
    after.revoke();
    return { exitCode: 0, stdout: after.output, stderr: '' };
  });
  await expect(after.stageRemote()).rejects.toThrow('authority expired');
  expect(after.run).toHaveBeenCalledOnce();
});

it.each(['missing', 'duplicate', 'oversized', 'digest', 'component', 'version'] as const)(
  'rejects %s returned stage evidence',
  async (kind) => {
    const f = fixture();
    let output = f.output;
    if (kind === 'missing') output = 'No stage receipt\n';
    else if (kind === 'duplicate') output += f.output;
    else if (kind === 'oversized') output = 'PUDDLE_HOST_STAGE ' + 'a'.repeat(4096);
    else {
      const receipt = structuredClone(f.stage);
      if (kind === 'component') receipt.record.component = 'daemon';
      if (kind === 'version') {
        receipt.record.version = '0.4.1';
        receipt.record.generation = '0.4.1~ABC123';
      }
      receipt.digest =
        kind === 'digest'
          ? digest('different record')
          : digest(`${JSON.stringify(receipt.record)}\n`);
      output = `PUDDLE_HOST_STAGE ${JSON.stringify(receipt)}\n`;
    }
    f.run.mockResolvedValueOnce({ exitCode: 0, stdout: output, stderr: '' });
    await expect(f.stageRemote()).rejects.toThrow();
    expect(f.run).toHaveBeenCalledOnce();
  },
);

it('does not accept a receipt from a failed command or repeat a bounded runner failure', async () => {
  const f = fixture();
  f.run.mockResolvedValueOnce({ exitCode: 1, stdout: f.output, stderr: 'private host diagnostic' });
  await expect(f.stageRemote()).rejects.toThrow('Host release preparation failed');
  f.run.mockRejectedValueOnce(new Error('Bounded runner deadline exceeded'));
  await expect(f.stageRemote()).rejects.toThrow('deadline exceeded');
  expect(f.run).toHaveBeenCalledTimes(2);
});
