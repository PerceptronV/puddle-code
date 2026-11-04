import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  HOST_MEMORY_LEDGER_BYTES,
  memoryFile,
  memoryPaths,
  requireMemorySidecars,
} from '../../../../src/runtime/resources/host/storage.js';

vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>();
  return { ...real, lstatSync: vi.fn(real.lstatSync) };
});
const real = await vi.importActual<typeof import('node:fs')>('node:fs');
const homes: string[] = [];
afterEach(() => {
  vi.mocked(lstatSync).mockReset().mockImplementation(real.lstatSync);
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'puddle-memory-sidecar-'));
  homes.push(home);
  const paths = memoryPaths(home)!;
  const journal = paths.database + '-journal';
  writeFileSync(journal, 'rollback journal fixture', { mode: 0o600 });
  return { paths, journal };
}

/** Deterministically reproduce macOS lstat returning an inode concurrently unlinked. */
function unlinkedObservation(file: string, after: () => void, change?: (stat: Stats) => void) {
  const stat = real.lstatSync(file);
  stat.nlink = 0;
  change?.(stat);
  vi.mocked(lstatSync).mockClear();
  vi.mocked(lstatSync).mockImplementationOnce((path) => {
    expect(path).toBe(file);
    after();
    return stat;
  });
}

it('accepts a concurrently deleted rollback journal without retrying database work', () => {
  const { paths, journal } = fixture();
  unlinkedObservation(journal, () => unlinkSync(journal));
  expect(() => requireMemorySidecars(paths)).not.toThrow();
  expect(vi.mocked(lstatSync).mock.calls.filter(([path]) => path === journal)).toHaveLength(2);
});

it('fully validates a fresh singly linked replacement journal', () => {
  const { paths, journal } = fixture();
  unlinkedObservation(journal, () => {
    unlinkSync(journal);
    writeFileSync(journal, 'new transaction', { mode: 0o600 });
  });
  expect(() => requireMemorySidecars(paths)).not.toThrow();
});

it.each(['permissions', 'file type', 'link count', 'oversized', 'owner'])(
  'refuses an unsafe replacement journal: %s',
  (reason) => {
    const { paths, journal } = fixture();
    unlinkedObservation(journal, () => {
      unlinkSync(journal);
      writeFileSync(journal, 'replacement', { mode: 0o600 });
      if (reason === 'permissions') chmodSync(journal, 0o644);
      if (reason === 'file type') {
        unlinkSync(journal);
        symlinkSync(paths.database, journal);
      }
      if (reason === 'link count') linkSync(journal, journal + '-link');
      if (reason === 'oversized') truncateSync(journal, HOST_MEMORY_LEDGER_BYTES + 1024 * 1024 + 1);
      if (reason === 'owner') {
        const replacement = real.lstatSync(journal);
        replacement.uid = (process.getuid?.() ?? 0) + 1;
        vi.mocked(lstatSync).mockReturnValueOnce(replacement);
      }
    });
    expect(() => requireMemorySidecars(paths)).toThrow(reason);
    expect(vi.mocked(lstatSync).mock.calls.filter(([path]) => path === journal)).toHaveLength(2);
  },
);

it('refuses a second unlinked observation without a polling loop', () => {
  const { paths, journal } = fixture();
  unlinkedObservation(journal, () => {
    const stat = real.lstatSync(journal);
    stat.nlink = 0;
    vi.mocked(lstatSync).mockReturnValueOnce(stat);
  });
  expect(() => requireMemorySidecars(paths)).toThrow(
    'link count: managed-memory.sqlite-journal (0)',
  );
  expect(lstatSync).toHaveBeenCalledTimes(2);
});

it.each(['permissions', 'owner', 'oversized', 'link count'])(
  'does not re-observe a first unsafe journal: %s',
  (reason) => {
    const { paths, journal } = fixture();
    unlinkedObservation(
      journal,
      () => {},
      (stat) => {
        if (reason === 'permissions') stat.mode |= 0o044;
        if (reason === 'owner') stat.uid = (process.getuid?.() ?? 0) + 1;
        if (reason === 'oversized') stat.size = HOST_MEMORY_LEDGER_BYTES + 1024 * 1024 + 1;
        if (reason === 'link count') stat.nlink = 2;
      },
    );
    expect(() => requireMemorySidecars(paths)).toThrow(reason);
    expect(lstatSync).toHaveBeenCalledTimes(1);
  },
);

it.each(['managed-memory.sqlite', 'managed-memory.seal', 'managed-memory.sqlite-wal'])(
  'never tolerates an unlinked permanent or unexpected file: %s',
  (name) => {
    const { paths } = fixture();
    const file = join(paths.directory, name);
    writeFileSync(file, '', { mode: 0o600 });
    unlinkedObservation(file, () => unlinkSync(file));
    expect(() => memoryFile(file, HOST_MEMORY_LEDGER_BYTES)).toThrow('link count');
    expect(lstatSync).toHaveBeenCalledTimes(1);
  },
);

it.each(['-wal', '-shm'])('still refuses SQLite %s sidecars', (suffix) => {
  const { paths } = fixture();
  writeFileSync(paths.database + suffix, '', { mode: 0o600 });
  expect(() => requireMemorySidecars(paths)).toThrow('Unexpected host memory ledger WAL state');
});
