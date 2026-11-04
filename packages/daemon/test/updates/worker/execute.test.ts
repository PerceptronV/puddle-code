import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { runCompilationCommand } from '../../../src/compilation/process.js';
import { executeHostUpdate } from '../../../src/updates/worker/execute.js';
import { recordUpdateWorkerLifetime } from '../../../src/updates/worker/lifetime.js';
import { verifyHostUpdateCompletion } from '../../../src/updates/verification/completion.js';
import { updateInstallation as fixture } from '../../helpers/update-installation.js';

// Installer composition uses simulated supervision; lifetime has separate process tests.
vi.mock('../../../src/updates/worker/lifetime.js', () => ({
  recordUpdateWorkerLifetime: vi.fn(async () => {}),
}));

it('uses the canonical installer, verifies exact selection and consumes the operation once', async () => {
  const f = await fixture();
  let commands = 0;
  await executeHostUpdate(f.puddleHome, f.job, async (command) => {
    commands++;
    expect(command.detached).toBe(false);
    expect(command.env).not.toHaveProperty('CLAUDECODE');
    expect(command.args).toContain('--select-only');
    return runCompilationCommand(command);
  });
  expect(f.selected('runtime')).toBe(
    join(f.puddleHome, 'bin/versions', f.receipt.record.generation),
  );
  expect(readFileSync(f.marker, 'utf8')).toBe('launchd\n');
  expect(f.store.read()?.phase).toBe('complete');
  expect(f.store.read()?.verification).toMatch(/^[a-f0-9]{64}$/);
  await expect(
    executeHostUpdate(f.puddleHome, f.job, async () => {
      commands++;
      throw new Error('must not run');
    }),
  ).rejects.toThrow();
  expect(commands).toBe(1);
}, 30_000);

it('refuses a changed candidate without selecting it, retaining a recoverable operation', async () => {
  const f = await fixture();
  writeFileSync(
    join(f.puddleHome, 'bin/versions', f.receipt.record.generation, 'daemon/puddler.mjs'),
    'changed',
  );
  await expect(executeHostUpdate(f.puddleHome, f.job)).rejects.toThrow();
  expect(f.selected('runtime')).toBe(f.previous);
  expect(f.store.read()?.phase).toBe('recovery_required');
}, 30_000);

it('refuses all activation commands when the worker lifetime cannot be recorded', async () => {
  const f = await fixture();
  vi.mocked(recordUpdateWorkerLifetime).mockRejectedValueOnce(new Error('lifetime unavailable'));
  const run = vi.fn(async () => {
    throw new Error('No activation permitted');
  });
  await expect(executeHostUpdate(f.puddleHome, f.job, run)).rejects.toThrow('lifetime unavailable');
  expect(run).not.toHaveBeenCalled();
  expect(f.selected('runtime')).toBe(f.previous);
  expect(f.store.read()?.phase).toBe('recovery_required');
}, 30_000);

it('does not accept successful command output as verification of the selected generation', async () => {
  const f = await fixture();
  await expect(
    executeHostUpdate(f.puddleHome, f.job, async () => ({
      exitCode: 0,
      stdout: 'installed',
      stderr: '',
    })),
  ).rejects.toThrow('approved stage');
  expect(f.selected('runtime')).toBe(f.previous);
  expect(f.store.read()?.phase).toBe('recovery_required');
}, 30_000);

it('keeps a successful selection after a lost reply and never repeats activation automatically', async () => {
  const f = await fixture();
  await expect(
    executeHostUpdate(f.puddleHome, f.job, async (command) => {
      await runCompilationCommand(command);
      throw new Error('activation reply lost');
    }),
  ).rejects.toThrow('reply lost');
  expect(f.selected('runtime')).toBe(
    join(f.puddleHome, 'bin/versions', f.receipt.record.generation),
  );
  expect(f.store.read()?.phase).toBe('recovery_required');
  await expect(executeHostUpdate(f.puddleHome, f.job)).rejects.toThrow();
  expect(f.store.begin(f.operation.targets).created).toBe(false);
  const recovery = f.store.read()!;
  const run = async () => {
    throw new Error('Recovery verification must not run installation commands');
  };
  expect(await verifyHostUpdateCompletion(f.puddleHome, f.job, recovery, run)).toMatch(
    /^[a-f0-9]{64}$/,
  );
  // Evidence alone neither resolves recovery nor grants a new dispatch.
  expect(f.store.read()).toEqual(recovery);
  await expect(
    verifyHostUpdateCompletion(
      f.puddleHome,
      { ...f.job, preflight: '0'.repeat(64) },
      recovery,
      run,
    ),
  ).rejects.toThrow('changed');
}, 30_000);
