import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { hostUpdateWorkerSchema } from '@puddle/shared';
import { digest } from '@puddle/shared/node';
import { hostInstallationFixture } from '../../../../cli/test/helpers/host-installation.js';
import { stageHostComponent } from '../../../../cli/src/lib/installation/host/staging.js';
import { runCompilationCommand } from '../../../src/compilation/process.js';
import { HostUpdateOperations } from '../../../src/updates/operations/store.js';
import { executeHostUpdate } from '../../../src/updates/worker/execute.js';

async function fixture() {
  const f = hostInstallationFixture();
  // Exact release resolution requires its own Node file, not a link outside the tree.
  rmSync(join(f.staged, 'bin/node'));
  copyFileSync(process.execPath, join(f.staged, 'bin/node'));
  mkdirSync(join(f.staged, 'daemon'));
  writeFileSync(join(f.staged, 'daemon/puddler.mjs'), '// fake provider-free runtime entry\n');
  f.pack();
  writeFileSync(
    `${f.tarball}.sha256`,
    `${createHash('sha256').update(readFileSync(f.tarball)).digest('hex')}  ${f.tarball.split('/').pop()}\n`,
  );
  f.install('--component', 'runtime');
  const previous = f.selected('runtime');
  const marker = join(f.puddleHome, 'supervisor');
  writeFileSync(marker, 'launchd\n');
  const receipt = await stageHostComponent(f.transport, 'runtime', {
    version: '1.2.3',
    tarball: f.tarball,
  });
  const store = new HostUpdateOperations(f.puddleHome);
  let operation = store.begin([{ component: 'runtime', version: '1.2.3' }]).operation;
  operation = store.staged(operation, receipt);
  operation = store.preflight(operation, digest('exact preflight'));
  operation = store.approve(operation, operation.preflight!);
  operation = store.dispatch(operation);
  const job = hostUpdateWorkerSchema.parse({
    format: 1,
    operation_id: operation.id,
    dispatch_id: operation.dispatch_id,
    dispatch_revision: operation.revision,
    preflight: operation.preflight,
    kind: 'launchd',
    name: `dev.puddle.update.${operation.id}`,
    domain: 'gui/501',
    release_path: f.staged,
    node_path: process.execPath,
    entry_path: join(f.staged, 'worker.mjs'),
    installer_path: fileURLToPath(new URL('../../../../../scripts/install.sh', import.meta.url)),
    state: 'dispatched',
  });
  return { ...f, receipt, store, operation, job, previous, marker };
}

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
