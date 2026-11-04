import * as fs from 'node:fs/promises';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RUNTIME_LIMITS } from '@puddle/shared';
import { RuntimeStateWriter } from '../../../src/runtime/state/persistence.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    rename: vi.fn(actual.rename),
    unlink: vi.fn(actual.unlink),
  };
});
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const cleanups: Array<() => void | Promise<void>> = [];
beforeEach(() => {
  vi.mocked(fs.open).mockReset().mockImplementation(actual.open);
  vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename);
  vi.mocked(fs.unlink).mockReset().mockImplementation(actual.unlink);
});
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
function fixture(
  kind: 'journal' | 'checkpoint' = 'journal',
  options: ConstructorParameters<typeof RuntimeStateWriter>[2] = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'puddle-runtime-writer-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'events.json');
  writeFileSync(file, 'old\n', { mode: 0o600 });
  return { root, file, writer: new RuntimeStateWriter(root, kind, options) };
}
const error = (code: string) => Object.assign(new Error(code), { code });
async function nextHandle(change: (handle: fs.FileHandle) => void) {
  vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
    const handle = await actual.open(...args);
    const close = handle.close.bind(handle);
    cleanups.push(async () => {
      await close().catch(() => {});
    });
    change(handle);
    return handle;
  });
}

it('reuses a fixed slot after successful atomic saves without changing destination privacy', async () => {
  const f = fixture();
  for (let index = 0; index < 8; index++) await f.writer.write(f.file, `${index}\n`);
  expect(readFileSync(f.file, 'utf8')).toBe('7\n');
  expect(statSync(f.file).mode & 0o777).toBe(0o600);
  expect(readdirSync(f.root)).toEqual(['events.json']);
  expect(
    new Set(
      vi
        .mocked(fs.open)
        .mock.calls.filter(([, flags]) => flags === 'wx')
        .map(([path]) => path),
    ),
  ).toEqual(new Set([join(f.root, '.journal-0.tmp')]));
});

it('bounds leftover checkpoint slots across changing destination generations and repeated cleanup failure', async () => {
  const f = fixture('checkpoint', { slots: 2 });
  const storage = error('ENOSPC');
  for (let index = 0; index < 2; index++) {
    await nextHandle((handle) => {
      handle.sync = vi.fn(async () => {
        throw storage;
      });
    });
    vi.mocked(fs.unlink).mockRejectedValueOnce(error('EIO'));
    await expect(
      f.writer.write(join(f.root, `checkpoint-${index}.json`), 'pending\n'),
    ).rejects.toBe(storage);
  }
  for (let index = 2; index < 20; index++)
    await expect(
      f.writer.write(join(f.root, `checkpoint-${index}.json`), 'later\n'),
    ).rejects.toThrow('slots are unavailable');
  expect(readdirSync(f.root).sort()).toEqual([
    '.checkpoint-0.tmp',
    '.checkpoint-1.tmp',
    'events.json',
  ]);
  expect(readFileSync(join(f.root, '.checkpoint-0.tmp'), 'utf8')).toBe('pending\n');
  expect(readFileSync(f.file, 'utf8')).toBe('old\n');
  expect(fs.open).toHaveBeenCalledTimes(2);
});

it('never removes an existing unowned slot, including after its path disappears', async () => {
  const f = fixture();
  const slot = join(f.root, '.journal-0.tmp');
  writeFileSync(slot, 'uncertain\n', { mode: 0o600 });
  await expect(f.writer.write(f.file, 'next\n')).rejects.toMatchObject({ code: 'EEXIST' });
  expect(fs.unlink).not.toHaveBeenCalled();
  expect(readFileSync(slot, 'utf8')).toBe('uncertain\n');
  await actual.unlink(slot);
  await expect(f.writer.write(f.file, 'later\n')).rejects.toThrow('slots are unavailable');
  expect(fs.open).toHaveBeenCalledTimes(1);
  expect(readFileSync(f.file, 'utf8')).toBe('old\n');
});

it('retains the slot and original error after an uncertain file close, without unlinking an open file', async () => {
  const f = fixture();
  const storage = error('EDQUOT');
  await nextHandle((handle) => {
    handle.writeFile = vi.fn(async () => {
      throw storage;
    });
    handle.close = vi.fn(async () => {
      throw error('EIO');
    });
  });
  await expect(f.writer.write(f.file, 'next\n')).rejects.toBe(storage);
  await expect(f.writer.write(f.file, 'later\n')).rejects.toThrow('slots are unavailable');
  expect(fs.unlink).not.toHaveBeenCalled();
  expect(readdirSync(f.root).sort()).toEqual(['.journal-0.tmp', 'events.json']);
  expect(readFileSync(f.file, 'utf8')).toBe('old\n');
});

it('pins an uncertain directory descriptor even after its temporary was renamed', async () => {
  const f = fixture();
  const storage = error('EIO');
  vi.mocked(fs.open).mockImplementationOnce(actual.open);
  await nextHandle((handle) => {
    handle.close = vi.fn(async () => {
      throw storage;
    });
  });
  await expect(f.writer.write(f.file, 'new\n')).rejects.toBe(storage);
  expect(readFileSync(f.file, 'utf8')).toBe('new\n');
  expect(readdirSync(f.root)).toEqual(['events.json']);
  await expect(f.writer.write(f.file, 'later\n')).rejects.toThrow('slots are unavailable');
  expect(fs.unlink).not.toHaveBeenCalled();
});

it.each(['write', 'sync', 'rename'] as const)(
  'allows a later save only after %s failure has closed and cleaned its own temporary',
  async (operation) => {
    const f = fixture();
    const storage = error('ENOSPC');
    if (operation === 'rename') vi.mocked(fs.rename).mockRejectedValueOnce(storage);
    else
      await nextHandle((handle) => {
        if (operation === 'write')
          handle.writeFile = vi.fn(async () => {
            throw storage;
          });
        else
          handle.sync = vi.fn(async () => {
            throw storage;
          });
      });
    await expect(f.writer.write(f.file, 'failed\n')).rejects.toBe(storage);
    expect(readFileSync(f.file, 'utf8')).toBe('old\n');
    expect(readdirSync(f.root)).toEqual(['events.json']);
    await f.writer.write(f.file, 'recovered\n');
    expect(readFileSync(f.file, 'utf8')).toBe('recovered\n');
  },
);

it('preserves a renamed destination after directory sync failure and reuses only its closed slot', async () => {
  const f = fixture();
  const storage = error('EIO');
  vi.mocked(fs.open).mockImplementationOnce(actual.open);
  await nextHandle((handle) => {
    handle.sync = vi.fn(async () => {
      throw storage;
    });
  });
  await expect(f.writer.write(f.file, 'uncertain-durability\n')).rejects.toBe(storage);
  expect(readFileSync(f.file, 'utf8')).toBe('uncertain-durability\n');
  await f.writer.write(f.file, 'recovered\n');
  expect(readFileSync(f.file, 'utf8')).toBe('recovered\n');
});

it('rejects oversized UTF-8 including the newline before allocating a slot', async () => {
  const f = fixture('journal', { maxBytes: 4 });
  await expect(f.writer.write(f.file, 'éé\n')).rejects.toThrow('byte limit');
  expect(fs.open).not.toHaveBeenCalled();
  await f.writer.write(f.file, 'é\n');
  expect(readFileSync(f.file, 'utf8')).toBe('é\n');
});

it('does not release an in-flight slot to a concurrent save', async () => {
  const f = fixture();
  let release!: () => void;
  await nextHandle((handle) => {
    handle.sync = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
  });
  const saving = f.writer.write(f.file, 'first\n');
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await expect(f.writer.write(f.file, 'second\n')).rejects.toThrow('slots are unavailable');
  release();
  await saving;
  await f.writer.write(f.file, 'third\n');
  expect(readFileSync(f.file, 'utf8')).toBe('third\n');
});

it('does not delete an unowned path created after its own successful rename', async () => {
  const f = fixture();
  vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
    await actual.rename(from, to);
    await actual.writeFile(from, 'unowned\n', { mode: 0o600 });
  });
  await f.writer.write(f.file, 'new\n');
  expect(fs.unlink).not.toHaveBeenCalled();
  await expect(f.writer.write(f.file, 'next\n')).rejects.toMatchObject({ code: 'EEXIST' });
  expect(readFileSync(join(f.root, '.journal-0.tmp'), 'utf8')).toBe('unowned\n');
});

it('does not enlarge the finite production slot or byte ceilings', () => {
  expect(() => fixture('journal', { slots: 2 })).toThrow('limits');
  expect(() => fixture('checkpoint', { slots: RUNTIME_LIMITS.pendingCheckpoints + 1 })).toThrow(
    'limits',
  );
  expect(() => fixture('journal', { maxBytes: RUNTIME_LIMITS.journalBytes + 1 })).toThrow('limits');
});
