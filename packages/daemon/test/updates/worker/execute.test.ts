import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runCompilationCommand } from '../../../src/compilation/process.js';
import { executeHostUpdate } from '../../../src/updates/worker/execute.js';
import { updateInstallation as fixture } from '../../helpers/update-installation.js';

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
}, 30_000);
