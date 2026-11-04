import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { expect, it } from 'vitest';
import { hostStageRecordSchema } from '@puddle/shared';
import { hostInstallationFixture as fixture } from '../../helpers/host-installation.js';
import { activateHostStage } from '../../../src/lib/installation/host/staging.js';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const receipt = (directory: string) =>
  hostStageRecordSchema.parse(
    JSON.parse(readFileSync(join(directory, '.puddle-stage.json'), 'utf8')),
  );
function sums(f: ReturnType<typeof fixture>) {
  const digest = hash(readFileSync(f.tarball));
  const file = `${f.tarball}.sha256`;
  writeFileSync(file, `${digest}  ${basename(f.tarball)}\n`);
  return { file, digest };
}

it('records a verified daemon bootstrap once for its shared initial runtime generation', () => {
  const f = fixture();
  const expected = sums(f);
  const output = f.install('--sums', expected.file);
  const directory = f.selected();
  expect(f.selected('runtime')).toBe(directory);
  expect(receipt(directory)).toMatchObject({
    component: 'daemon',
    generation: basename(directory),
    version: '1.2.3',
    protocol: { major: 25, minor: 20 },
    archive_sha256: expected.digest,
    checksum_verified: true,
  });
  expect(statSync(join(directory, '.puddle-stage.json')).mode & 0o777).toBe(0o600);
  expect(output).not.toContain('PUDDLE_HOST_STAGE');
});

it('keeps an unchecked local receipt unverified when a later install supplies checksums', () => {
  const f = fixture();
  f.install();
  const directory = f.selected();
  const marker = join(directory, '.puddle-stage.json');
  const before = readFileSync(marker, 'utf8');
  const inode = statSync(marker).ino;
  expect(receipt(directory).checksum_verified).toBe(false);
  f.install('--sums', sums(f).file);
  expect(f.selected()).toBe(directory);
  expect(readFileSync(marker, 'utf8')).toBe(before);
  expect(statSync(marker).ino).toBe(inode);
});

it('attests the verified private archive snapshot even if the caller replaces its source during smoke', () => {
  const f = fixture();
  Object.assign(f.env, { FIXTURE_SOURCE_ARCHIVE: f.tarball });
  writeFileSync(
    f.stagedBinary,
    '#!/bin/sh\nprintf "replaced caller archive" > "$FIXTURE_SOURCE_ARCHIVE"\nprintf "puddled 1.2.3\\n"\n',
    { mode: 0o755 },
  );
  f.pack();
  const expected = sums(f);
  f.install('--sums', expected.file);
  expect(hash(readFileSync(f.tarball))).not.toBe(expected.digest);
  expect(receipt(f.selected())).toMatchObject({
    archive_sha256: expected.digest,
    checksum_verified: true,
  });
});

it('does not retrospectively attest or change a healthy reused legacy tree', () => {
  const f = fixture();
  const directory = join(f.puddleHome, 'bin/versions/1.2.3');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  cpSync(f.staged, directory, { recursive: true });
  symlinkSync('versions/1.2.3', join(f.puddleHome, 'bin/current'));
  const binary = join(directory, 'puddled');
  const source = readFileSync(binary, 'utf8');
  const before = statSync(directory);
  const inode = statSync(binary).ino;
  f.install('--sums', sums(f).file);
  expect(f.selected()).toBe(directory);
  expect(readFileSync(binary, 'utf8')).toBe(source);
  expect(statSync(binary).ino).toBe(inode);
  expect(statSync(directory).mtimeMs).toBe(before.mtimeMs);
  expect(existsSync(join(directory, '.puddle-stage.json'))).toBe(false);
});

it('writes a new receipt on forced repair while retaining the independently selected old runtime', () => {
  const f = fixture();
  const verified = sums(f);
  f.install('--sums', verified.file);
  const previous = f.selected();
  const original = readFileSync(join(previous, '.puddle-stage.json'), 'utf8');
  f.install('--force', '--sums', verified.file);
  expect(f.selected()).not.toBe(previous);
  expect(f.selected('runtime')).toBe(previous);
  expect(readFileSync(join(previous, '.puddle-stage.json'), 'utf8')).toBe(original);
  expect(receipt(f.selected())).toMatchObject({
    generation: basename(f.selected()),
    component: 'daemon',
    checksum_verified: true,
  });
});

it('retains the runtime receipt when a later daemon install reuses that generation', () => {
  const f = fixture();
  const verified = sums(f);
  f.install('--component', 'runtime', '--sums', verified.file);
  const directory = f.selected('runtime');
  const original = readFileSync(join(directory, '.puddle-stage.json'), 'utf8');
  expect(receipt(directory)).toMatchObject({
    component: 'runtime',
    protocol: { major: 1, minor: 0 },
  });
  expect(existsSync(join(f.puddleHome, 'bin/current'))).toBe(false);
  f.install('--sums', verified.file);
  expect(f.selected()).toBe(directory);
  expect(readFileSync(join(directory, '.puddle-stage.json'), 'utf8')).toBe(original);
});

it.each(['missing', 'linked', 'oversized'] as const)(
  'rejects %s modern protocol metadata before selection',
  (kind) => {
    const f = fixture();
    const protocol = join(f.staged, 'PROTOCOL');
    if (kind === 'oversized') writeFileSync(protocol, '1'.repeat(34));
    else {
      rmSync(protocol);
      if (kind === 'linked') symlinkSync(join(f.staged, 'RUNTIME_PROTOCOL'), protocol);
    }
    f.pack();
    expect(() => f.install('--sums', sums(f).file)).toThrow('staged release verification failed');
    expect(existsSync(join(f.puddleHome, 'bin/current'))).toBe(false);
    expect(existsSync(join(f.puddleHome, 'bin/runtime-current'))).toBe(false);
    expect(f.generations()).toEqual([]);
  },
);

it('keeps historical archives without protocol metadata usable but unverified', () => {
  const f = fixture();
  for (const name of ['PROTOCOL', 'RUNTIME_PROTOCOL', 'puddler']) rmSync(join(f.staged, name));
  f.pack();
  f.install('--sums', sums(f).file);
  expect(existsSync(join(f.selected(), '.puddle-stage.json'))).toBe(false);
  expect(existsSync(join(f.puddleHome, 'bin/runtime-current'))).toBe(false);
});

it('retains a durably receipted generation when initial runtime validation fails before either selector', () => {
  const f = fixture();
  writeFileSync(join(f.staged, 'puddler'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  f.pack();
  expect(() => f.install('--sums', sums(f).file)).toThrow('initial runtime fails');
  expect(existsSync(join(f.puddleHome, 'bin/current'))).toBe(false);
  expect(existsSync(join(f.puddleHome, 'bin/runtime-current'))).toBe(false);
  expect(f.generations()).toHaveLength(1);
  expect(receipt(join(f.puddleHome, 'bin/versions', f.generations()[0]!)).checksum_verified).toBe(
    true,
  );
});

it('rejects archive-supplied proof instead of overwriting it with a trusted receipt', () => {
  const f = fixture();
  writeFileSync(join(f.staged, '.puddle-stage.json'), '{}\n', { mode: 0o600 });
  f.pack();
  expect(() => f.install('--sums', sums(f).file)).toThrow('staged release verification failed');
  expect(f.generations()).toEqual([]);
  expect(existsSync(join(f.puddleHome, 'bin/current'))).toBe(false);
});

it('uses the same exact activation integrity gate for a bootstrap receipt after its archive disappears', async () => {
  const f = fixture();
  writeFileSync(f.stagedBinary, '#!/bin/sh\nprintf "puddled 1.2.3 (protocol 25.20)\\n"\n', {
    mode: 0o755,
  });
  f.pack();
  f.install('--sums', sums(f).file);
  const directory = f.selected();
  const marker = readFileSync(join(directory, '.puddle-stage.json'));
  const accepted = { record: receipt(directory), digest: hash(marker) };
  rmSync(f.tarball);
  await activateHostStage(f.transport, accepted, { noSupervisor: true });
  expect(f.selected()).toBe(directory);
  writeFileSync(join(directory, 'unexpected'), 'changed immutable tree');
  await expect(activateHostStage(f.transport, accepted, { noSupervisor: true })).rejects.toThrow(
    'installer failed',
  );
  expect(f.selected()).toBe(directory);
  expect(readFileSync(join(directory, '.puddle-stage.json'))).toEqual(marker);
});
