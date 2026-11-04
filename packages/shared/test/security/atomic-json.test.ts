import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { atomicPrivateJson } from '../../src/node/security.js';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    fsyncSync: vi.fn(actual.fsyncSync),
    closeSync: vi.fn(actual.closeSync),
    renameSync: vi.fn(actual.renameSync),
    rmSync: vi.fn(actual.rmSync),
  };
});
const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
let home: string;
let file: string;
beforeEach(() => {
  vi.mocked(fs.openSync).mockReset().mockImplementation(actual.openSync);
  vi.mocked(fs.writeFileSync).mockReset().mockImplementation(actual.writeFileSync);
  vi.mocked(fs.fsyncSync).mockReset().mockImplementation(actual.fsyncSync);
  vi.mocked(fs.closeSync).mockReset().mockImplementation(actual.closeSync);
  vi.mocked(fs.renameSync).mockReset().mockImplementation(actual.renameSync);
  vi.mocked(fs.rmSync).mockReset().mockImplementation(actual.rmSync);
  home = actual.mkdtempSync(join(tmpdir(), 'puddle-atomic-json-'));
  file = join(home, 'state.json');
  actual.writeFileSync(file, '{"old":true}\n', { mode: 0o600 });
});
afterEach(() => actual.rmSync(home, { recursive: true, force: true }));
const unchanged = () => {
  expect(actual.readFileSync(file, 'utf8')).toBe('{"old":true}\n');
  expect(actual.readdirSync(home)).toEqual(['state.json']);
};
const failure = (code: string) => Object.assign(new Error(`fixture ${code}`), { code });

it('closes and syncs the private temporary before replacement, then syncs the directory', () => {
  atomicPrivateJson(file, { next: true }, { syncDirectory: true });
  expect(actual.readFileSync(file, 'utf8')).toBe('{"next":true}\n');
  expect(actual.statSync(file).mode & 0o777).toBe(0o600);
  expect(actual.readdirSync(home)).toEqual(['state.json']);
  expect(vi.mocked(fs.fsyncSync).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(fs.closeSync).mock.invocationCallOrder[0]!,
  );
  expect(vi.mocked(fs.closeSync).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(fs.renameSync).mock.invocationCallOrder[0]!,
  );
  expect(vi.mocked(fs.renameSync).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(fs.fsyncSync).mock.invocationCallOrder[1]!,
  );
  expect(fs.rmSync).not.toHaveBeenCalled();
});

it('cleans up after serialisation fails without replacing the previous destination', () => {
  const error = failure('SERIALISE');
  expect(() =>
    atomicPrivateJson(file, {
      toJSON() {
        throw error;
      },
    }),
  ).toThrow(error);
  expect(fs.writeFileSync).not.toHaveBeenCalled();
  expect(fs.closeSync).toHaveBeenCalledOnce();
  expect(fs.rmSync).toHaveBeenCalledOnce();
  unchanged();
});

it('cleans up a partial write and preserves its ENOSPC classification', () => {
  const error = failure('ENOSPC');
  vi.mocked(fs.writeFileSync).mockImplementationOnce((fd) => {
    actual.writeFileSync(fd, 'partial');
    throw error;
  });
  expect(() => atomicPrivateJson(file, { next: true })).toThrow(error);
  expect(fs.closeSync).toHaveBeenCalledOnce();
  expect(fs.renameSync).not.toHaveBeenCalled();
  unchanged();
});

it.each(['fsync', 'rename', 'close'] as const)(
  'cleans up after %s failure with the old destination intact',
  (operation) => {
    const error = failure('EIO');
    if (operation === 'fsync')
      vi.mocked(fs.fsyncSync).mockImplementationOnce(() => {
        throw error;
      });
    if (operation === 'rename')
      vi.mocked(fs.renameSync).mockImplementationOnce(() => {
        throw error;
      });
    if (operation === 'close')
      vi.mocked(fs.closeSync).mockImplementationOnce((fd) => {
        actual.closeSync(fd);
        throw error;
      });
    expect(() => atomicPrivateJson(file, { next: true })).toThrow(error);
    expect(fs.rmSync).toHaveBeenCalledOnce();
    unchanged();
  },
);

it('preserves the original storage failure when descriptor close and temporary cleanup also fail', () => {
  const error = failure('EDQUOT');
  vi.mocked(fs.writeFileSync).mockImplementationOnce(() => {
    throw error;
  });
  vi.mocked(fs.closeSync).mockImplementationOnce((fd) => {
    actual.closeSync(fd);
    throw failure('EIO');
  });
  vi.mocked(fs.rmSync).mockImplementationOnce(() => {
    throw failure('EACCES');
  });
  expect(() => atomicPrivateJson(file, { next: true })).toThrow(error);
  expect(fs.rmSync).toHaveBeenCalledOnce();
  expect(actual.readFileSync(file, 'utf8')).toBe('{"old":true}\n');
  expect(actual.readdirSync(home)).toHaveLength(2); // Unresolved cleanup is retained, not claimed successful.
});

it('does not remove an unowned temporary when exclusive open fails', () => {
  const error = failure('EEXIST');
  let unowned = '';
  vi.mocked(fs.openSync).mockImplementationOnce((path) => {
    unowned = String(path);
    actual.writeFileSync(path, 'another writer', { mode: 0o600 });
    throw error;
  });
  expect(() => atomicPrivateJson(file, { next: true })).toThrow(error);
  expect(fs.rmSync).not.toHaveBeenCalled();
  expect(fs.closeSync).not.toHaveBeenCalled();
  expect(actual.readFileSync(unowned, 'utf8')).toBe('another writer');
  expect(actual.readFileSync(file, 'utf8')).toBe('{"old":true}\n');
});

it('retains the new destination when directory fsync fails after rename', () => {
  const error = failure('EIO');
  vi.mocked(fs.fsyncSync)
    .mockImplementationOnce(actual.fsyncSync)
    .mockImplementationOnce(() => {
      throw error;
    });
  expect(() => atomicPrivateJson(file, { next: true }, { syncDirectory: true })).toThrow(error);
  expect(actual.readFileSync(file, 'utf8')).toBe('{"next":true}\n');
  expect(actual.readdirSync(home)).toEqual(['state.json']);
  expect(fs.renameSync).toHaveBeenCalledOnce();
  expect(fs.rmSync).not.toHaveBeenCalled();
});

it('does not unlink a newly occupied temporary path after its own file was renamed', () => {
  let unowned = '';
  vi.mocked(fs.renameSync).mockImplementationOnce((from, to) => {
    actual.renameSync(from, to);
    unowned = String(from);
    actual.writeFileSync(from, 'another writer', { mode: 0o600 });
  });
  atomicPrivateJson(file, { next: true });
  expect(actual.readFileSync(unowned, 'utf8')).toBe('another writer');
  expect(actual.readFileSync(file, 'utf8')).toBe('{"next":true}\n');
  expect(fs.rmSync).not.toHaveBeenCalled();
});
