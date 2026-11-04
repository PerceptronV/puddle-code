import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AtomicFileSlotsSync } from '../../../src/storage/atomic/sync.js';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    fsyncSync: vi.fn(actual.fsyncSync),
    closeSync: vi.fn(actual.closeSync),
    renameSync: vi.fn(actual.renameSync),
    unlinkSync: vi.fn(actual.unlinkSync),
  };
});
const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.mocked(fs.openSync).mockReset().mockImplementation(actual.openSync);
  vi.mocked(fs.writeFileSync).mockReset().mockImplementation(actual.writeFileSync);
  vi.mocked(fs.fsyncSync).mockReset().mockImplementation(actual.fsyncSync);
  vi.mocked(fs.closeSync).mockReset().mockImplementation(actual.closeSync);
  vi.mocked(fs.renameSync).mockReset().mockImplementation(actual.renameSync);
  vi.mocked(fs.unlinkSync).mockReset().mockImplementation(actual.unlinkSync);
});
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});
function fixture(syncDirectory = false, maxBytes = 1024) {
  const root = actual.mkdtempSync(join(tmpdir(), 'puddle-sync-slots-'));
  cleanups.push(() => actual.rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'state.json');
  actual.writeFileSync(file, 'old\n', { mode: 0o600 });
  const writer = new AtomicFileSlotsSync({
    directory: root,
    prefix: 'state',
    slots: 1,
    maxBytes,
    syncFile: true,
    syncDirectory,
  });
  return { root, file, writer, temporary: join(root, '.state-0.tmp') };
}
const error = (code: string) => Object.assign(new Error(code), { code });
const throwsExact = (fn: () => void, expected: Error) => {
  let caught: unknown;
  try {
    fn();
  } catch (value) {
    caught = value;
  }
  expect(caught).toBe(expected);
};

it('reuses its one private slot after close-before-rename and directory sync', () => {
  const f = fixture(true);
  for (let index = 0; index < 5; index++) f.writer.write(f.file, `${index}\n`);
  expect(actual.readFileSync(f.file, 'utf8')).toBe('4\n');
  expect(actual.statSync(f.file).mode & 0o777).toBe(0o600);
  expect(actual.readdirSync(f.root)).toEqual(['state.json']);
  expect(vi.mocked(fs.closeSync).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(fs.renameSync).mock.invocationCallOrder[0]!,
  );
  expect(
    new Set(
      vi
        .mocked(fs.openSync)
        .mock.calls.filter(([, flags]) => flags === 'wx')
        .map(([path]) => path),
    ),
  ).toEqual(new Set([f.temporary]));
});

it('cannot create retry files after cleanup failure and preserves the original storage error', () => {
  const f = fixture();
  const storage = error('ENOSPC');
  vi.mocked(fs.writeFileSync).mockImplementationOnce((fd) => {
    actual.writeFileSync(fd, 'partial');
    throw storage;
  });
  vi.mocked(fs.unlinkSync).mockImplementationOnce(() => {
    throw error('EIO');
  });
  throwsExact(() => f.writer.write(f.file, 'failed\n'), storage);
  for (let index = 0; index < 10; index++)
    expect(() => f.writer.write(f.file, 'retry\n')).toThrow('slots are unavailable');
  expect(actual.readdirSync(f.root).sort()).toEqual(['.state-0.tmp', 'state.json']);
  expect(actual.readFileSync(f.file, 'utf8')).toBe('old\n');
  expect(actual.readFileSync(f.temporary, 'utf8')).toBe('partial');
  expect(fs.openSync).toHaveBeenCalledOnce();
});

it('keeps a preexisting slot untouched without cleanup or automatic reuse', () => {
  const f = fixture();
  actual.writeFileSync(f.temporary, 'unknown', { mode: 0o600 });
  expect(() => f.writer.write(f.file, 'new\n')).toThrow(/EEXIST/);
  expect(fs.unlinkSync).not.toHaveBeenCalled();
  expect(actual.readFileSync(f.temporary, 'utf8')).toBe('unknown');
  actual.unlinkSync(f.temporary);
  expect(() => f.writer.write(f.file, 'retry\n')).toThrow('slots are unavailable');
});

it.each(['file', 'directory'] as const)(
  'pins an uncertain %s close and does not leak more descriptors or slots through retries',
  (kind) => {
    const f = fixture(kind === 'directory');
    const storage = error('EIO');
    if (kind === 'directory') vi.mocked(fs.closeSync).mockImplementationOnce(actual.closeSync);
    vi.mocked(fs.closeSync).mockImplementationOnce((fd) => {
      cleanups.push(() => {
        actual.closeSync(fd);
      });
      throw storage;
    });
    throwsExact(() => f.writer.write(f.file, 'next\n'), storage);
    const opens = vi.mocked(fs.openSync).mock.calls.length;
    for (let index = 0; index < 10; index++)
      expect(() => f.writer.write(f.file, 'later\n')).toThrow('slots are unavailable');
    expect(fs.openSync).toHaveBeenCalledTimes(opens);
    expect(fs.unlinkSync).not.toHaveBeenCalled();
    expect(actual.readdirSync(f.root).sort()).toEqual(
      kind === 'file' ? ['.state-0.tmp', 'state.json'] : ['state.json'],
    );
    expect(actual.readFileSync(f.file, 'utf8')).toBe(kind === 'file' ? 'old\n' : 'next\n');
  },
);

it.each(['write', 'sync', 'rename'] as const)(
  'recovers only after confirmed cleanup of a %s failure',
  (operation) => {
    const f = fixture();
    const storage = error('EDQUOT');
    if (operation === 'write')
      vi.mocked(fs.writeFileSync).mockImplementationOnce(() => {
        throw storage;
      });
    if (operation === 'sync')
      vi.mocked(fs.fsyncSync).mockImplementationOnce(() => {
        throw storage;
      });
    if (operation === 'rename')
      vi.mocked(fs.renameSync).mockImplementationOnce(() => {
        throw storage;
      });
    throwsExact(() => f.writer.write(f.file, 'failed\n'), storage);
    expect(actual.readdirSync(f.root)).toEqual(['state.json']);
    expect(actual.readFileSync(f.file, 'utf8')).toBe('old\n');
    f.writer.write(f.file, 'recovered\n');
    expect(actual.readFileSync(f.file, 'utf8')).toBe('recovered\n');
  },
);

it('does not publish or clean a substituted scratch inode', () => {
  const f = fixture();
  vi.mocked(fs.closeSync).mockImplementationOnce((fd) => {
    actual.closeSync(fd);
    actual.renameSync(f.temporary, join(f.root, 'retained-original'));
    actual.writeFileSync(f.temporary, 'unowned', { mode: 0o600 });
  });
  expect(() => f.writer.write(f.file, 'next\n')).toThrow('identity changed');
  expect(fs.unlinkSync).not.toHaveBeenCalled();
  expect(actual.readFileSync(f.temporary, 'utf8')).toBe('unowned');
  expect(actual.readFileSync(f.file, 'utf8')).toBe('old\n');
  expect(() => f.writer.write(f.file, 'retry\n')).toThrow('slots are unavailable');
});

it('keeps a renamed destination when directory sync fails, then safely reuses the closed slot', () => {
  const f = fixture(true);
  const storage = error('EIO');
  vi.mocked(fs.fsyncSync)
    .mockImplementationOnce(actual.fsyncSync)
    .mockImplementationOnce(() => {
      throw storage;
    });
  throwsExact(() => f.writer.write(f.file, 'new\n'), storage);
  expect(actual.readFileSync(f.file, 'utf8')).toBe('new\n');
  expect(fs.unlinkSync).not.toHaveBeenCalled();
  f.writer.write(f.file, 'recovered\n');
  expect(actual.readFileSync(f.file, 'utf8')).toBe('recovered\n');
});

it('enforces the encoded bound including newline before any file or descriptor is allocated', () => {
  const f = fixture(false, 4);
  expect(() => f.writer.write(f.file, 'éé\n')).toThrow('byte limit');
  expect(fs.openSync).not.toHaveBeenCalled();
  f.writer.write(f.file, 'é\n');
  expect(actual.readFileSync(f.file, 'utf8')).toBe('é\n');
});
