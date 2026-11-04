import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  statSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  stageHostComponent,
  activateHostStage,
} from '../../../src/lib/installation/host/staging.js';
import { hostInstallationFixture } from '../../helpers/host-installation.js';

function fixture() {
  const f = hostInstallationFixture();
  writeFileSync(f.stagedBinary, '#!/bin/sh\nprintf "puddled 1.2.3 (protocol 25.6)\\n"\n');
  writeFileSync(join(f.staged, 'PROTOCOL'), '25.6\n');
  // Include a native/helper stand-in so integrity covers more than launchers.
  mkdirSync(join(f.staged, 'daemon', 'node_modules'), { recursive: true });
  writeFileSync(join(f.staged, 'daemon', 'node_modules', 'native.node'), 'native dependency');
  f.pack();
  const hash = createHash('sha256').update(readFileSync(f.tarball)).digest('hex');
  writeFileSync(`${f.tarball}.sha256`, `${hash}  ${f.tarball.split('/').pop()}\n`);
  return { ...f, hash, options: { version: '1.2.3', tarball: f.tarball } };
}

it.each(['systemd', 'launchd', 'nohup'])(
  'selects an exact daemon stage without changing %s supervision',
  async (kind) => {
    const f = fixture();
    f.install();
    const marker = join(f.puddleHome, 'supervisor');
    writeFileSync(marker, `${kind}\n`);
    const receipt = await stageHostComponent(f.transport, 'daemon', f.options);
    await activateHostStage(f.transport, receipt, { selectOnly: true });
    expect(f.selected()).toBe(join(f.puddleHome, 'bin', 'versions', receipt.record.generation));
    expect(readFileSync(marker, 'utf8')).toBe(`${kind}\n`);
    expect(existsSync(join(f.env.HOME, '.config/systemd/user/puddled.service'))).toBe(false);
    expect(existsSync(join(f.env.HOME, 'Library/LaunchAgents/dev.puddle.puddled.plist'))).toBe(
      false,
    );
    expect(existsSync(join(f.puddleHome, 'puddled.pid'))).toBe(false);
  },
);

it('refuses selection-only without exact activation or alongside supervisor flags', async () => {
  const f = fixture();
  expect(() => f.install('--select-only')).toThrow();
  expect(existsSync(join(f.puddleHome, 'bin/current'))).toBe(false);
  const receipt = await stageHostComponent(f.transport, 'daemon', f.options);
  await expect(
    activateHostStage(f.transport, receipt, { selectOnly: true, noSupervisor: true }),
  ).rejects.toThrow();
  expect(existsSync(join(f.puddleHome, 'bin/current'))).toBe(false);
});

it.each(['daemon', 'runtime'] as const)(
  'stages %s without activation and applies the exact receipt after its archive disappears',
  async (component) => {
    const f = fixture();
    f.install();
    const previous = f.selected();
    const previousRuntime = f.selected('runtime');
    const runtimeWrapper = readFileSync(join(f.puddleHome, 'bin/puddler'), 'utf8');
    const supervisor = readFileSync(join(f.puddleHome, 'supervisor'), 'utf8');
    const receipt = await stageHostComponent(f.transport, component, f.options);
    expect(receipt.record).toMatchObject({
      component,
      version: '1.2.3',
      archive_sha256: f.hash,
      checksum_verified: true,
    });
    expect(f.selected()).toBe(previous);
    expect(readFileSync(join(f.puddleHome, 'supervisor'), 'utf8')).toBe(supervisor);
    expect(f.selected('runtime')).toBe(previousRuntime);
    expect(readFileSync(join(f.puddleHome, 'bin/puddler'), 'utf8')).toBe(runtimeWrapper);
    const directory = join(f.puddleHome, 'bin', 'versions', receipt.record.generation);
    expect(directory).not.toBe(previous);
    expect(existsSync(join(directory, '.puddle-stage.json'))).toBe(true);
    rmSync(f.tarball);
    rmSync(`${f.tarball}.sha256`);
    await activateHostStage(f.transport, receipt, { noSupervisor: true });
    expect(f.selected(component)).toBe(directory);
    if (component === 'runtime') expect(f.selected()).toBe(previous);
    expect(existsSync(previous)).toBe(true);
  },
);

it.each(['receipt', 'dependency', 'mode', 'symlink', 'extra', 'missing'])(
  'preserves the selection and diagnostic stage when %s changes after staging',
  async (mutation) => {
    const f = fixture();
    f.install();
    const previous = f.selected();
    const previousRuntime = f.selected('runtime');
    const receipt = await stageHostComponent(f.transport, 'runtime', f.options);
    const directory = join(f.puddleHome, 'bin', 'versions', receipt.record.generation);
    const dependency = join(directory, 'daemon', 'node_modules', 'native.node');
    if (mutation === 'receipt') writeFileSync(join(directory, '.puddle-stage.json'), '{}\n');
    if (mutation === 'dependency') writeFileSync(dependency, 'corrupt native dependency');
    if (mutation === 'mode') chmodSync(dependency, 0o777);
    if (mutation === 'symlink') {
      rmSync(dependency);
      symlinkSync(f.stagedBinary, dependency);
    }
    if (mutation === 'extra') writeFileSync(join(directory, 'extra'), 'unexpected');
    if (mutation === 'missing') rmSync(dependency);
    await expect(activateHostStage(f.transport, receipt)).rejects.toThrow('installer failed');
    expect(f.selected()).toBe(previous);
    expect(existsSync(directory)).toBe(true);
    expect(f.selected('runtime')).toBe(previousRuntime);
    expect(statSync(join(f.puddleHome, 'bin', '.install-lock')).isFile()).toBe(true);
  },
);

it('requires the exact receipt and component before selecting a retained stage', async () => {
  const f = fixture();
  const receipt = await stageHostComponent(f.transport, 'runtime', f.options);
  expect(existsSync(join(f.puddleHome, 'bin', 'runtime-current'))).toBe(false);
  expect(existsSync(join(f.puddleHome, 'supervisor'))).toBe(false);
  await expect(
    activateHostStage(f.transport, { ...receipt, digest: '0'.repeat(64) }),
  ).rejects.toThrow();
  await expect(
    activateHostStage(
      f.transport,
      { ...receipt, record: { ...receipt.record, component: 'daemon' } },
      { noSupervisor: true },
    ),
  ).rejects.toThrow();
  await expect(
    activateHostStage(f.transport, {
      ...receipt,
      record: { ...receipt.record, generation: '../outside' },
    }),
  ).rejects.toThrow();
  expect(f.generations()).toEqual([receipt.record.generation]);
});

it('records explicitly unverified local stages and rejects checksum failures before retaining a tree', async () => {
  const f = fixture();
  writeFileSync(`${f.tarball}.sha256`, `${'0'.repeat(64)}  ${f.tarball.split('/').pop()}\n`);
  await expect(stageHostComponent(f.transport, 'runtime', f.options)).rejects.toThrow();
  expect(f.generations()).toEqual([]);
  rmSync(`${f.tarball}.sha256`);
  expect(
    (await stageHostComponent(f.transport, 'runtime', f.options)).record.checksum_verified,
  ).toBe(false);
});

it('verifies SSH-delivered relative archive and checksum paths through the same bootstrap', async () => {
  const f = fixture();
  const transport = { ...f.transport, kind: 'ssh' as const };
  const receipt = await stageHostComponent(transport, 'runtime', f.options);
  expect(receipt.record.checksum_verified).toBe(true);
  expect(receipt.record.archive_sha256).toBe(f.hash);
  expect(existsSync(join(f.puddleHome, 'bin', 'runtime-current'))).toBe(false);
  await activateHostStage(transport, receipt);
  expect(f.selected('runtime')).toBe(
    join(f.puddleHome, 'bin', 'versions', receipt.record.generation),
  );
});
