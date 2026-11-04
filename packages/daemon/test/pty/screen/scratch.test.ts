import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ScreenSnapshotFiles, screenScratchPath } from '../../../src/pty/screen/persistence.js';
import { TerminalScreenStateStore } from '../../../src/pty/terminal-screen-state.js';

vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();
  const writes = vi.fn(real.writeFile);
  return {
    ...real,
    writeFile: writes,
    unlink: vi.fn(real.unlink),
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args);
      handle.writeFile = (data, options) => writes(handle, data, options);
      return handle;
    },
  };
});
const homes: string[] = [];
afterEach(async () => {
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(writeFile).mockReset().mockImplementation(real.writeFile);
  vi.mocked(unlink).mockReset().mockImplementation(real.unlink);
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'puddle-screen-scratch-'));
  homes.push(home);
  return { home, files: new ScreenSnapshotFiles(home), file: join(home, 'session', 'screen') };
}

it('reuses two fixed scratch identities across successful session churn and cancelled captures', async () => {
  const f = fixture();
  for (let index = 0; index < 20; index++) {
    const file = join(f.home, `session-${index}`, 'screen');
    await expect(f.files.save(file, 'old', () => true)).resolves.toBe(true);
    await expect(f.files.save(file, 'cancelled', () => false)).resolves.toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('old');
  }
  expect(readdirSync(f.home).filter((name) => name.startsWith('.screen-write-'))).toEqual([]);
});

it('fences failed cleanup across all keys, preserves the first failure and never changes good data', async () => {
  const f = fixture();
  await f.files.save(f.file, 'good', () => true);
  const failure = Object.assign(new Error('write full'), { code: 'ENOSPC' });
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(writeFile).mockImplementation(async (...args) => {
    await real.writeFile(...args);
    throw failure;
  });
  vi.mocked(unlink).mockRejectedValue(new Error('cleanup denied'));
  await expect(f.files.save(f.file, 'partial one', () => true)).rejects.toBe(failure);
  await expect(f.files.save(f.file, 'partial two', () => true)).rejects.toBe(failure);
  for (let index = 0; index < 100; index++)
    await expect(
      f.files.save(join(f.home, `other-${index}`, 'screen'), 'more', () => true),
    ).rejects.toThrow(/scratch capacity/);
  expect(readFileSync(f.file, 'utf8')).toBe('good');
  expect(
    readdirSync(f.home)
      .filter((name) => !name.startsWith('other-'))
      .sort(),
  ).toEqual(['.screen-write-0.tmp', '.screen-write-1.tmp', 'session']);
  expect(writeFile).toHaveBeenCalledTimes(3);
  expect(unlink).toHaveBeenCalledTimes(2);
});

it('does not adopt, overwrite or remove pre-existing scratch files after store replacement', async () => {
  const f = fixture();
  for (const slot of [0, 1]) writeFileSync(screenScratchPath(f.home, slot), 'unknown owner');
  for (let incarnation = 0; incarnation < 3; incarnation++) {
    const files = new ScreenSnapshotFiles(f.home);
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(files.save(f.file, 'new', () => true)).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(files.save(f.file, 'new', () => true)).rejects.toThrow(/scratch capacity/);
  }
  expect(writeFile).not.toHaveBeenCalled();
  expect(unlink).not.toHaveBeenCalled();
  for (const slot of [0, 1])
    expect(readFileSync(screenScratchPath(f.home, slot), 'utf8')).toBe('unknown owner');
});

it('leaves a replaced scratch inode untouched and fences only its slot', async () => {
  const f = fixture();
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
    await real.writeFile(...args);
    await real.rename(screenScratchPath(f.home, 0), join(f.home, 'moved-owned-file'));
    writeFileSync(screenScratchPath(f.home, 0), 'replacement');
  });
  await expect(f.files.save(f.file, 'old owner', () => true)).rejects.toThrow(/identity changed/);
  expect(unlink).not.toHaveBeenCalled();
  expect(readFileSync(screenScratchPath(f.home, 0), 'utf8')).toBe('replacement');
  await f.files.save(f.file, 'other slot', () => true);
  expect(readFileSync(f.file, 'utf8')).toBe('other slot');
});

it('bounds simultaneous writes and keeps both scratch slots reserved until IO settles', async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(writeFile).mockImplementation(async (...args) => {
    await gate;
    await real.writeFile(...args);
  });
  const first = f.files.save(f.file, 'first', () => true);
  const second = f.files.save(join(f.home, 'other', 'screen'), 'second', () => true);
  try {
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalledTimes(2));
    await expect(
      f.files.save(join(f.home, 'third', 'screen'), 'third', () => true),
    ).rejects.toThrow(/capacity/);
    expect(readdirSync(f.home).filter((name) => name.startsWith('.screen-write-'))).toHaveLength(2);
  } finally {
    release();
    await Promise.all([first, second]);
  }
  expect(readdirSync(f.home).filter((name) => name.startsWith('.screen-write-'))).toEqual([]);
});

it('reports exhausted scratch capacity while live canonical parsing continues', async () => {
  const f = fixture();
  const health = vi.fn();
  const store = new TerminalScreenStateStore(f.home, health);
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  try {
    store.write('session', 'agent', 'last good');
    await store.release('session', 'agent');
    const file = join(f.home, 'session', 'agent.terminal.json');
    const good = readFileSync(file, 'utf8');
    vi.mocked(writeFile).mockImplementation(async (...args) => {
      await real.writeFile(...args);
      throw Object.assign(new Error('full'), { code: 'ENOSPC' });
    });
    vi.mocked(unlink).mockRejectedValue(new Error('cleanup failed'));
    for (const stream of ['session', 'second']) {
      now += 60_000;
      store.write(stream, 'agent', 'unsaved');
      await store.release(stream, 'agent');
    }
    now += 60_000;
    store.write('live', 'agent', 'still parsing');
    expect(await store.snapshot('live', 'agent')).toContain('still parsing');
    await store.closeAll();
    expect(health).toHaveBeenCalledWith(true);
    expect(readFileSync(file, 'utf8')).toBe(good);
    expect(writeFile).toHaveBeenCalledTimes(3);
    expect(readdirSync(f.home).filter((name) => name.startsWith('.screen-write-'))).toHaveLength(2);
  } finally {
    await store.closeAll();
    clock.mockRestore();
    warning.mockRestore();
  }
});
