import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import {
  HostMemoryLedger,
  HOST_MEMORY_GRANT_ROWS,
  type HostMemoryIdentity,
} from '../../../../src/runtime/resources/host/ledger.js';
import { acquireHostClaim, HostClaimBusy } from '../../../../src/security/claims.js';
import { AtomicFileSlotsSync } from '../../../../src/storage/atomic/sync.js';
import { RuntimeHostAllowance } from '../../../../src/runtime/resources/host/allowance.js';
import { RuntimeBufferBudget } from '../../../../src/runtime/resources/budget.js';

vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>();
  return {
    ...real,
    closeSync: vi.fn(real.closeSync),
    lstatSync: vi.fn(real.lstatSync),
    readSync: vi.fn(real.readSync),
    writeFileSync: vi.fn(real.writeFileSync),
  };
});
const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');

const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(closeSync).mockReset().mockImplementation(realFs.closeSync);
  vi.mocked(lstatSync).mockReset().mockImplementation(realFs.lstatSync);
  vi.mocked(readSync).mockReset().mockImplementation(realFs.readSync);
  vi.mocked(writeFileSync).mockReset().mockImplementation(realFs.writeFileSync);
  for (const close of cleanup.splice(0).reverse()) close();
});
function fixture(capacity = 100) {
  const home = mkdtempSync(join(tmpdir(), 'puddle-host-memory-'));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const open = () => {
    const ledger = HostMemoryLedger.open(home, capacity);
    cleanup.push(() => ledger.close());
    return ledger;
  };
  return {
    home,
    open,
    file: join(home, 'runtime-claims/managed-memory.sqlite'),
    seal: join(home, 'runtime-claims/managed-memory.seal'),
  };
}
function identity(): HostMemoryIdentity {
  return { runtime_id: randomUUID(), incarnation: randomUUID(), launch_id: randomUUID() };
}

it('shares exact absolute revisioned grants across connections and reopens', () => {
  const f = fixture();
  const a = f.open(),
    b = f.open(),
    owner = identity(),
    other = identity();
  expect(a.instanceId).toBe(b.instanceId);
  expect(a.readGrant(owner)).toBeNull();
  expect(a.compareGrant(owner, 0, 60)).toEqual({ revision: 1, bytes: 60 });
  expect(b.compareGrant(other, 0, 41)).toBeNull();
  expect(b.compareGrant(other, 0, 40)).toEqual({ revision: 1, bytes: 40 });
  expect(b.compareGrant(owner, 0, 1)).toBeNull();
  expect(a.compareGrant(owner, 1, 30)).toEqual({ revision: 2, bytes: 30 });
  expect(b.compareGrant(other, 1, 70)).toEqual({ revision: 2, bytes: 70 });
  a.close();
  b.close();
  expect(f.open().readGrant(owner)).toEqual({ revision: 2, bytes: 30 });
  expect(statSync(f.file).mode & 0o777).toBe(0o600);
  expect(statSync(f.seal).mode & 0o777).toBe(0o600);
});

it('recovers failure between database commit and seal publication without replacing its identity', () => {
  const f = fixture();
  vi.spyOn(AtomicFileSlotsSync.prototype, 'write').mockImplementationOnce(() => {
    throw new Error('seal write failed');
  });
  expect(() => f.open()).toThrow('seal write failed');
  const inode = statSync(f.file).ino;
  const db = new Database(f.file);
  const header = db.prepare('SELECT instance FROM host_memory').get() as { instance: string };
  db.close();
  expect(f.open().instanceId).toBe(header.instance);
  expect(statSync(f.file).ino).toBe(inode);
});

it('recovers matching incomplete initial scratch and retains an unknown scratch file', () => {
  const f = fixture(),
    ledger = f.open();
  ledger.close();
  const seal = readFileSync(f.seal, 'utf8');
  const scratch = join(f.home, 'runtime-claims/.managed-memory-seal-0.tmp');
  rmSync(f.seal);
  writeFileSync(scratch, seal.slice(0, 40), { mode: 0o600 });
  f.open().close();
  expect(readFileSync(f.seal, 'utf8')).toBe(seal);
  rmSync(f.seal);
  writeFileSync(scratch, 'unknown content', { mode: 0o600 });
  expect(() => f.open()).toThrow(/Unknown memory initialisation/);
  expect(readFileSync(scratch, 'utf8')).toBe('unknown content');
});

it('reopens after seal publication succeeded but durability acknowledgement failed', () => {
  const f = fixture();
  const write = AtomicFileSlotsSync.prototype.write;
  vi.spyOn(AtomicFileSlotsSync.prototype, 'write').mockImplementationOnce(function (
    this: AtomicFileSlotsSync,
    ...args
  ) {
    write.apply(this, args);
    throw new Error('lost seal directory sync acknowledgement');
  });
  expect(() => f.open()).toThrow(/lost seal/);
  const seal = JSON.parse(readFileSync(f.seal, 'utf8')) as { instance: string };
  const ledger = f.open();
  expect(ledger.instanceId).toBe(seal.instance);
  expect(ledger.compareGrant(identity(), 0, 100)).toEqual({ revision: 1, bytes: 100 });
});

it('fences descriptor work after a real close-shaped seal read failure while ordinary read failures recover', () => {
  const f = fixture(),
    ledger = f.open(),
    owner = identity();
  ledger.compareGrant(owner, 0, 20);
  const readError = Object.assign(new Error('read failed'), { code: 'EIO', syscall: 'read' });
  vi.mocked(readSync).mockImplementationOnce(() => {
    throw readError;
  });
  expect(() => ledger.readGrant(owner)).toThrow(readError);
  expect(ledger.readGrant(owner)).toEqual({ revision: 1, bytes: 20 });
  const closeError = Object.assign(new Error('close uncertain'), { code: 'EIO', syscall: 'close' });
  let descriptor: number | undefined;
  vi.mocked(closeSync).mockImplementationOnce((fd) => {
    descriptor = fd;
    throw closeError;
  });
  try {
    expect(() => ledger.readGrant(owner)).toThrow(closeError);
    const calls = vi.mocked(closeSync).mock.calls.length;
    for (let attempt = 0; attempt < 8; attempt++) {
      expect(() => ledger.readGrant(owner)).toThrow(closeError);
      expect(() => f.open()).toThrow(closeError);
    }
    expect(closeSync).toHaveBeenCalledTimes(calls);
  } finally {
    if (descriptor !== undefined) realFs.closeSync(descriptor);
  }
});

it('retains the same failed seal writer when its first error hides an uncertain close', () => {
  const f = fixture();
  const write = AtomicFileSlotsSync.prototype.write;
  const writeError = Object.assign(new Error('disk full'), { code: 'ENOSPC', syscall: 'write' });
  const closeError = Object.assign(new Error('close uncertain'), { code: 'EIO', syscall: 'close' });
  let descriptor: number | undefined;
  vi.spyOn(AtomicFileSlotsSync.prototype, 'write').mockImplementationOnce(function (
    this: AtomicFileSlotsSync,
    ...args
  ) {
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw writeError;
    });
    vi.mocked(closeSync).mockImplementationOnce((fd) => {
      descriptor = fd;
      throw closeError;
    });
    return write.apply(this, args);
  });
  try {
    expect(() => f.open()).toThrow(writeError);
    const scratch = join(f.home, 'runtime-claims/.managed-memory-seal-0.tmp');
    const inode = statSync(scratch).ino;
    for (let attempt = 0; attempt < 8; attempt++)
      expect(() => f.open()).toThrow(/slots are unavailable/);
    expect(statSync(scratch).ino).toBe(inode);
  } finally {
    if (descriptor !== undefined) realFs.closeSync(descriptor);
  }
});

it('fences repeated opens after uncertain directory close following seal publication', () => {
  const f = fixture();
  const failure = Object.assign(new Error('directory close uncertain'), {
    code: 'EIO',
    syscall: 'close',
  });
  let descriptor: number | undefined;
  vi.mocked(closeSync).mockImplementation((fd) => {
    if (realFs.fstatSync(fd).isDirectory() && realFs.existsSync(f.seal)) {
      descriptor = fd;
      throw failure;
    }
    realFs.closeSync(fd);
  });
  try {
    expect(() => f.open()).toThrow(failure);
    const calls = vi.mocked(closeSync).mock.calls.length;
    for (let attempt = 0; attempt < 8; attempt++) expect(() => f.open()).toThrow(failure);
    expect(closeSync).toHaveBeenCalledTimes(calls);
  } finally {
    if (descriptor !== undefined) realFs.closeSync(descriptor);
  }
});

it('shares real durable capacity between owner caches and independent child domains', () => {
  const f = fixture(),
    ledger = f.open(),
    first = identity(),
    second = identity();
  const a = new RuntimeHostAllowance(ledger, first, 20, 0);
  const b = new RuntimeHostAllowance(ledger, second, 20, 0);
  const output = new RuntimeBufferBudget({ bytes: 100, count: 4 }, a);
  const screen = new RuntimeBufferBudget({ bytes: 100, count: 4 }, a);
  const other = new RuntimeBufferBudget({ bytes: 100, count: 4 }, b);
  const releaseOutput = output.reserve(35)!;
  const releaseScreen = screen.reserve(20)!;
  expect(a.usedBytes).toBe(55);
  const releaseOther = other.reserve(40)!;
  expect(other.reserve(6)).toBeNull();
  const reopened = f.open();
  expect(reopened.readGrant(first)).toEqual({ revision: 2, bytes: 60 });
  expect(reopened.compareGrant(identity(), 0, 1)).toBeNull();
  releaseOutput();
  expect(a.trim()).toBe(true);
  const regained = other.reserve(30);
  expect(regained).not.toBeNull();
  expect(reopened.readGrant(first)?.bytes).toBe(20);
  expect(reopened.readGrant(second)?.bytes).toBe(80);
  regained?.();
  releaseOther();
  releaseScreen();
  expect(a.trim()).toBe(true);
  expect(b.trim()).toBe(true);
  expect(reopened.compareGrant(identity(), 0, 100)).toEqual({ revision: 1, bytes: 100 });
});

it('allows concurrent sealed opens in isolated processes and retains grants after their exit', async () => {
  const f = fixture();
  const parent = f.open();
  const packageRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  const entry = join(f.home, 'ledger-child.cjs');
  symlinkSync(join(packageRoot, 'node_modules'), join(f.home, 'node_modules'));
  await build({
    stdin: {
      contents: `import { HostMemoryLedger } from './src/runtime/resources/host/ledger.ts';
const ledger = HostMemoryLedger.open(process.argv[2], 100);
try {
  const result = process.argv[3] ? ledger.compareGrant(JSON.parse(process.argv[3]), 0, Number(process.argv[4])) : { instance: ledger.instanceId };
  process.stdout.write(JSON.stringify(result));
} finally { ledger.close(); }`,
      resolveDir: packageRoot,
      sourcefile: 'ledger-child.ts',
      loader: 'ts',
    },
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['better-sqlite3'],
    logLevel: 'silent',
  });
  const child = async (owner?: HostMemoryIdentity, bytes?: number): Promise<unknown> => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [entry, f.home, ...(owner ? [JSON.stringify(owner), String(bytes)] : [])],
      {
        env: { HOME: f.home, PATH: process.env.PATH },
        timeout: 5000,
        maxBuffer: 4096,
      },
    );
    return JSON.parse(stdout);
  };
  const opened = await Promise.all(Array.from({ length: 8 }, () => child()));
  expect(opened).toEqual(Array.from({ length: 8 }, () => ({ instance: parent.instanceId })));
  const first = identity(),
    second = identity();
  expect(await child(first, 60)).toEqual({ revision: 1, bytes: 60 });
  expect(await child(second, 41)).toBeNull();
  expect(await child(second, 40)).toEqual({ revision: 1, bytes: 40 });
  expect(parent.readGrant(first)?.bytes).toBe(60);
  expect(parent.compareGrant(identity(), 0, 1)).toBeNull();
}, 15_000);

it('keeps zero-byte identity/revision evidence and refuses another incarnation', () => {
  const f = fixture(),
    ledger = f.open(),
    owner = identity();
  ledger.compareGrant(owner, 0, 30);
  expect(ledger.compareGrant(owner, 1, 0)).toEqual({ revision: 2, bytes: 0 });
  expect(() => ledger.readGrant({ ...owner, incarnation: randomUUID() })).toThrow(/identity/);
  expect(() => ledger.compareGrant({ ...owner, launch_id: randomUUID() }, 2, 1)).toThrow(
    /identity/,
  );
  expect(ledger.readGrant(owner)).toEqual({ revision: 2, bytes: 0 });
});

it('refuses first initialisation alongside a controller or any earlier runtime directory', () => {
  const f = fixture();
  const controller = acquireHostClaim(f.home, 'daemon-controller');
  try {
    expect(() => f.open()).toThrow(HostClaimBusy);
  } finally {
    controller.release();
  }
  mkdirSync(join(f.home, 'runtimes', randomUUID()), { recursive: true, mode: 0o700 });
  expect(() => f.open()).toThrow(/Existing runtime launches/);
});

it('opens a sealed ledger while the controller is held and runtime launches exist', () => {
  const f = fixture(),
    first = f.open(),
    owner = identity();
  first.compareGrant(owner, 0, 20);
  mkdirSync(join(f.home, 'runtimes', owner.runtime_id), { recursive: true, mode: 0o700 });
  const controller = acquireHostClaim(f.home, 'daemon-controller');
  try {
    expect(f.open().readGrant(owner)).toEqual({ revision: 1, bytes: 20 });
  } finally {
    controller.release();
  }
});

it('recovers an unsealed zero-grant initialisation on the same database inode', () => {
  const f = fixture(),
    first = f.open();
  const inode = statSync(f.file).ino,
    instance = first.instanceId;
  first.close();
  rmSync(f.seal);
  expect(f.open().instanceId).toBe(instance);
  expect(statSync(f.file).ino).toBe(inode);
});

it('never recreates a sealed missing ledger or seals rows whose grants already exist', () => {
  const f = fixture(),
    first = f.open();
  first.compareGrant(identity(), 0, 0);
  first.close();
  const seal = readFileSync(f.seal);
  rmSync(f.seal);
  expect(() => f.open()).toThrow(/grants exist without/);
  writeFileSync(f.seal, seal, { mode: 0o600 });
  rmSync(f.file);
  expect(() => f.open()).toThrow(/ledger is missing/);
});

it('refuses inode replacement on existing connections and future opens', () => {
  const f = fixture(),
    ledger = f.open(),
    owner = identity();
  ledger.compareGrant(owner, 0, 20);
  renameSync(f.file, f.file + '.old');
  writeFileSync(f.file, readFileSync(f.file + '.old'), { mode: 0o600 });
  expect(() => ledger.readGrant(owner)).toThrow(/identity changed/);
  expect(() => ledger.compareGrant(owner, 1, 30)).toThrow(/identity changed/);
  expect(() => f.open()).toThrow(/seal changed/);
});

it('retains grants across mount device renumbering but fences changes during an open connection', () => {
  const f = fixture(),
    ledger = f.open(),
    owner = identity();
  const instance = ledger.instanceId;
  ledger.compareGrant(owner, 0, 60);
  const seal = readFileSync(f.seal, 'utf8');
  vi.mocked(lstatSync).mockImplementation((...args: Parameters<typeof lstatSync>) => {
    const stat = realFs.lstatSync(...args);
    return Object.assign(stat, { dev: Number(stat.dev) + 2 });
  });
  expect(() => ledger.readGrant(owner)).toThrow(/identity changed/);
  ledger.close();
  const reopened = f.open();
  expect(reopened.instanceId).toBe(instance);
  expect(reopened.readGrant(owner)).toEqual({ revision: 1, bytes: 60 });
  expect(reopened.compareGrant(identity(), 0, 41)).toBeNull();
  expect(reopened.compareGrant(owner, 1, 70)).toEqual({ revision: 2, bytes: 70 });
  expect(readFileSync(f.seal, 'utf8')).toBe(seal);
  vi.mocked(lstatSync).mockImplementation(realFs.lstatSync);
  expect(() => reopened.readGrant(owner)).toThrow(/identity changed/);
});

it('rejects a ledger with a different instance even when its inode is unchanged', () => {
  const f = fixture();
  f.open().close();
  const db = new Database(f.file);
  db.prepare('UPDATE host_memory SET instance=?').run(randomUUID());
  db.close();
  expect(() => f.open()).toThrow(/seal changed/);
});

it('does not wait or mutate a grant when another transaction owns the ledger', () => {
  const f = fixture(),
    ledger = f.open(),
    owner = identity();
  const blocker = new Database(f.file, { timeout: 0 });
  try {
    blocker.exec('BEGIN IMMEDIATE');
    expect(() => ledger.compareGrant(owner, 0, 20)).toThrow(/locked/);
    blocker.exec('ROLLBACK');
    expect(ledger.readGrant(owner)).toBeNull();
  } finally {
    blocker.close();
  }
});

it('observes a committed but lost response without applying a blind increment twice', () => {
  const f = fixture(),
    owner = identity();
  const writer = f.open(),
    observer = f.open();
  // Simulate losing only the response after the real SQLite commit.
  writer.compareGrant(owner, 0, 70);
  expect(observer.readGrant(owner)).toEqual({ revision: 1, bytes: 70 });
  expect(observer.compareGrant(owner, 0, 70)).toBeNull();
  expect(observer.compareGrant(identity(), 0, 31)).toBeNull();
});

it('rejects changed totals, schemas, capacity, oversized files and malformed seals', () => {
  const f = fixture(),
    ledger = f.open();
  ledger.close();
  expect(() => HostMemoryLedger.open(f.home, 101)).toThrow(/seal changed/);
  const db = new Database(f.file);
  db.prepare('UPDATE host_memory SET total=1').run();
  db.close();
  expect(() => f.open()).toThrow(/total changed/);
  truncateSync(f.file, 16 * 1024 * 1024 + 1);
  expect(() => f.open()).toThrow(/oversized/);
  writeFileSync(f.seal, '{', { mode: 0o600 });
  expect(() => f.open()).toThrow();
});

it('initialises an empty permanent inode and rejects a changed trigger manifest', () => {
  const f = fixture();
  mkdirSync(join(f.home, 'runtime-claims'), { mode: 0o700 });
  writeFileSync(f.file, '', { mode: 0o600 });
  const inode = statSync(f.file).ino;
  f.open().close();
  expect(statSync(f.file).ino).toBe(inode);
  const db = new Database(f.file);
  db.exec('DROP TRIGGER grant_update');
  db.close();
  expect(() => f.open()).toThrow(/schema changed/);
});

it('checks the bounded owner count before scanning grant totals', () => {
  const f = fixture();
  f.open().close();
  const db = new Database(f.file);
  try {
    const insert = db.prepare('INSERT INTO grants VALUES (?,?,?,1,0)');
    db.transaction(() => {
      for (let index = 0; index < HOST_MEMORY_GRANT_ROWS; index++) {
        const owner = identity();
        insert.run(owner.runtime_id, owner.incarnation, owner.launch_id);
      }
    })();
    const full = f.open();
    expect(full.compareGrant(identity(), 0, 1)).toBeNull();
    full.close();
    // Corrupt only this private fixture to exercise fail-closed validation.
    db.pragma('ignore_check_constraints=ON');
    const extra = identity();
    insert.run(extra.runtime_id, extra.incarnation, extra.launch_id);
    db.exec('UPDATE host_memory SET owners=0');
  } finally {
    db.close();
  }
  const prepare = vi.spyOn(Database.prototype, 'prepare');
  expect(() => f.open()).toThrow(/owner count/);
  expect(prepare.mock.calls.some(([sql]) => sql.includes('SUM(bytes)'))).toBe(false);
});
