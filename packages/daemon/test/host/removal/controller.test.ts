import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { withRemovalRuntimes } from '../../../src/host/removal/controller.js';
import { HostRemovalGuard } from '../../../src/host/removal/guard.js';
import { acquireHostClaim } from '../../../src/security/claims.js';
import { acquireInstallationLock } from '../../../src/host/installation/lock.js';
import { openDatabase } from '../../../src/db/db.js';
import { DATABASE_SCHEMA_VERSION } from '../../../src/db/migrations/index.js';
import { runtimeDirectory } from '../../../src/runtime/ownership/storage.js';
import { initialiseRuntimeMemory } from '../../../src/runtime/resources/host/bootstrap.js';
import { HostUpdateOperations } from '../../../src/updates/operations/store.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'puddle-removal-controller-'));
  homes.push(home);
  return { home, file: join(home, 'puddle.db') };
}

it.each(['daemon-controller', 'host-update-coordinator', 'host-update-execution'])(
  'does not open SQLite or take over a live %s',
  async (scope) => {
    const f = fixture();
    const claim = acquireHostClaim(f.home, scope);
    const action = vi.fn();
    try {
      await expect(withRemovalRuntimes(f.home, action)).rejects.toThrow(/live process/);
      expect(action).not.toHaveBeenCalled();
      expect(existsSync(f.file)).toBe(false);
      expect(() => acquireHostClaim(f.home, scope)).toThrow();
    } finally {
      claim.release();
    }
  },
);

it('retains installer exclusion and releases its claims on a refused database', async () => {
  const f = fixture();
  const lock = acquireInstallationLock(f.home);
  try {
    await expect(withRemovalRuntimes(f.home, vi.fn())).rejects.toThrow(/installer/);
    expect(existsSync(f.file)).toBe(false);
  } finally {
    lock.release();
  }
  await expect(withRemovalRuntimes(f.home, vi.fn())).rejects.toThrow();
  for (const scope of ['daemon-controller', 'host-update-coordinator', 'host-update-execution'])
    acquireHostClaim(f.home, scope).release();
  acquireInstallationLock(f.home).release();
});

it.each([0, DATABASE_SCHEMA_VERSION - 1, DATABASE_SCHEMA_VERSION + 1])(
  'does not migrate or change an application database at schema %s',
  async (version) => {
    const f = fixture();
    const db = new Database(f.file);
    db.exec("CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('unchanged')");
    db.pragma(`user_version = ${version}`);
    db.close();
    const before = readFileSync(f.file);
    await expect(withRemovalRuntimes(f.home, vi.fn())).rejects.toThrow(/schema/);
    expect(readFileSync(f.file)).toEqual(before);
  },
);

it('accepts an owned legacy-readable database under the private home', async () => {
  const f = fixture();
  openDatabase(f.file).close();
  chmodSync(f.file, 0o644);
  const result = await withRemovalRuntimes(f.home, async (removal) => {
    const review = await removal.review(() => true);
    await removal.apply(review, 'retain', () => true);
    return review.owners;
  });
  expect(result).toEqual([]);
  expect(existsSync(f.file)).toBe(true);
});

it('refuses a linked database without touching its target', async () => {
  const f = fixture();
  const target = join(f.home, 'original.db');
  openDatabase(target).close();
  const before = readFileSync(target);
  symlinkSync(target, f.file);
  await expect(withRemovalRuntimes(f.home, vi.fn())).rejects.toThrow(/Unsafe/);
  expect(readFileSync(target)).toEqual(before);
});

it('keeps an unfinished update intact and requires its existing recovery path', async () => {
  const f = fixture();
  const updates = new HostUpdateOperations(f.home);
  const operation = updates.begin([{ component: 'daemon', version: '0.4.0' }]).operation;
  await expect(withRemovalRuntimes(f.home, vi.fn())).rejects.toThrow(/Resolve the host update/);
  expect(updates.read()).toEqual(operation);
  expect(existsSync(f.file)).toBe(false);
});

it('refuses an unknown on-disk runtime before offering a complete removal inventory', async () => {
  const f = fixture();
  openDatabase(f.file).close();
  initialiseRuntimeMemory(f.home);
  const directory = runtimeDirectory(f.home, randomUUID());
  const action = vi.fn();
  await expect(withRemovalRuntimes(f.home, action)).rejects.toThrow(/inventory is unknown/);
  expect(action).not.toHaveBeenCalled();
  expect(existsSync(directory)).toBe(true);
});

it('retains the outer removal guard after offline runtime handling and failed review', async () => {
  const f = fixture();
  openDatabase(f.file).close();
  const guard = HostRemovalGuard.acquire(f.home);
  try {
    for (const fail of [false, true]) {
      const handling = withRemovalRuntimes(
        f.home,
        async (removal) => {
          guard.requireController();
          expect(() => guard.acquireController()).toThrow(/already owns/);
          const review = await removal.review(() => true);
          if (fail) throw new Error('Review cancelled');
          await removal.apply(review, 'retain', () => true);
        },
        guard,
      );
      if (fail) await expect(handling).rejects.toThrow('Review cancelled');
      else await handling;
      expect(() => guard.requireController()).toThrow(/does not own/);
      guard.requireHeld();
      for (const scope of ['host-update-coordinator', 'host-update-execution'])
        expect(() => acquireHostClaim(f.home, scope)).toThrow(/owns/);
      expect(() => acquireInstallationLock(f.home)).toThrow(/installer/);
      // The runtime phase drains and releases only its controller claim.
      const controller = guard.acquireController();
      controller.release();
    }
  } finally {
    guard.release();
  }
  expect(() => guard.requireHeld()).toThrow(/no longer held/);
  acquireInstallationLock(f.home).release();
  acquireHostClaim(f.home, 'host-update-coordinator').release();
});

it('rejects an outer removal guard for another home without creating a database', async () => {
  const f = fixture();
  const other = fixture();
  const guard = HostRemovalGuard.acquire(f.home);
  try {
    await expect(withRemovalRuntimes(other.home, vi.fn(), guard)).rejects.toThrow(/this home/);
    expect(existsSync(other.file)).toBe(false);
    guard.requireHeld();
  } finally {
    guard.release();
  }
});
