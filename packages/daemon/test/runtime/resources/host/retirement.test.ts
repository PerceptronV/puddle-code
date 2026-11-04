import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import Database from 'better-sqlite3';
import {
  existsSync,
  fsyncSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import type { RuntimeIdentity, RuntimeLaunch } from '@puddle/shared';
import { atomicPrivateJson } from '@puddle/shared/node';
import {
  HostMemoryLedger,
  HOST_MEMORY_GRANT_ROWS,
} from '../../../../src/runtime/resources/host/ledger.js';
import { requireNoRuntimeMemoryGrants } from '../../../../src/runtime/resources/host/retirement.js';
import { acquireRuntimeRetirementClaims } from '../../../../src/runtime/ownership/retirement-claims.js';
import { runtimeDirectory } from '../../../../src/runtime/ownership/storage.js';
import { retireMissingRuntime } from '../../../../src/runtime/ownership/discovery.js';
import { removeRuntimeService } from '../../../../src/runtime/lifecycle/supervisor.js';
import { acquireHostClaim } from '../../../../src/security/claims.js';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) };
});
const cleanups: Array<() => void> = [];
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(fsyncSync).mockReset().mockImplementation(actualFs.fsyncSync);
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'puddle-memory-retirement-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const ledger = HostMemoryLedger.open(home, 100);
  cleanups.push(() => ledger.close());
  const identity: RuntimeIdentity = {
    runtime_id: randomUUID(),
    incarnation: randomUUID(),
    launch_id: randomUUID(),
    profile_id: '1111111111',
    project_id: '2222222222',
    session_id: randomUUID(),
    canonical_worktree_path: home,
  };
  const directory = runtimeDirectory(home, identity.runtime_id);
  atomicPrivateJson(join(directory, 'launch.json'), {
    format: 1,
    identity,
    secret: 'a'.repeat(64),
    main: { file: '/bin/sh', args: [], cwd: home, env: {}, cols: 80, rows: 24 },
  } satisfies RuntimeLaunch);
  ledger.compareGrant(identity, 0, 100);
  const fence = () => atomicPrivateJson(join(directory, 'retired.json'), { format: 1, identity });
  const claim = () => {
    const claim = acquireRuntimeRetirementClaims(home, identity.runtime_id);
    cleanups.push(() => claim.release());
    return claim;
  };
  return { home, ledger, identity, directory, fence, claim };
}

it('opens only established ledgers with their sealed capacity and never creates missing storage', () => {
  const f = fixture();
  const missing = join(f.home, 'absent');
  expect(HostMemoryLedger.openExisting(missing)).toBeNull();
  expect(existsSync(missing)).toBe(false);
  const reopened = HostMemoryLedger.openExisting(f.home)!;
  try {
    expect(reopened.capacityBytes).toBe(100);
    expect(reopened.instanceId).toBe(f.ledger.instanceId);
    expect(reopened.readGrant(f.identity)).toEqual({ revision: 1, bytes: 100 });
  } finally {
    reopened.close();
  }
  unlinkSync(join(f.home, 'runtime-claims/managed-memory.seal'));
  expect(() => HostMemoryLedger.openExisting(f.home)).toThrow('without an initialisation seal');
});

it('refuses a sealed missing database instead of creating another allowance', () => {
  const f = fixture();
  f.ledger.close();
  unlinkSync(join(f.home, 'runtime-claims/managed-memory.sqlite'));
  expect(() => HostMemoryLedger.openExisting(f.home)).toThrow(
    'Sealed host memory ledger is missing',
  );
  expect(existsSync(join(f.home, 'runtime-claims/managed-memory.sqlite'))).toBe(false);
});

it('requires the exact durable fence and held claims before reclaiming capacity and rows', () => {
  const f = fixture(),
    claims = f.claim();
  expect(() => f.ledger.retireGrant(f.identity, claims)).toThrow();
  expect(f.ledger.readGrant(f.identity)?.bytes).toBe(100);
  f.fence();
  atomicPrivateJson(join(f.directory, 'retired.json'), {
    format: 1,
    identity: { ...f.identity, launch_id: randomUUID() },
  });
  expect(() => f.ledger.retireGrant(f.identity, claims)).toThrow('identity changed');
  f.fence();
  expect(f.ledger.retireGrant(f.identity, claims)).toBe(true);
  expect(f.ledger.retireGrant(f.identity, claims)).toBe(false);
  expect(f.ledger.readGrant(f.identity)).toBeNull();
  expect(() => requireNoRuntimeMemoryGrants(f.home)).not.toThrow();
  const replacement = {
    ...f.identity,
    runtime_id: randomUUID(),
    incarnation: randomUUID(),
    launch_id: randomUUID(),
  };
  expect(f.ledger.compareGrant(replacement, 0, 100)).toEqual({ revision: 1, bytes: 100 });
  claims.release();
  expect(() => f.ledger.retireGrant(f.identity, claims)).toThrow('no longer held');
});

it.each(['runtime-launch', 'runtime-dispatch', 'runtime', 'runtime-memory'])(
  'retains the grant while the %s claim remains held',
  async (scope) => {
    const f = fixture();
    const live = acquireHostClaim(f.home, `${scope}:${f.identity.runtime_id}`);
    try {
      const apply = vi.fn();
      expect(retireMissingRuntime(f.home, f.identity, apply)).toBe('owned');
      expect(await removeRuntimeService(f.home, f.identity)).toBe('owned');
      expect(apply).not.toHaveBeenCalled();
      expect(f.ledger.readGrant(f.identity)?.bytes).toBe(100);
      expect(existsSync(join(f.directory, 'retired.json'))).toBe(false);
    } finally {
      live.release();
    }
    expect(retireMissingRuntime(f.home, f.identity, () => {})).toBe('retired');
    expect(f.ledger.readGrant(f.identity)).toBeNull();
  },
);

it('keeps grants after fence fsync failure, then safely retries the exact ended owner', () => {
  const f = fixture(),
    claims = f.claim();
  f.fence();
  vi.mocked(fsyncSync).mockImplementationOnce(() => {
    throw new Error('fence fsync failed');
  });
  expect(() => f.ledger.retireGrant(f.identity, claims)).toThrow('fence fsync failed');
  expect(f.ledger.readGrant(f.identity)?.bytes).toBe(100);
  expect(f.ledger.retireGrant(f.identity, claims)).toBe(true);
});

it('retires before an application commit can remove evidence and keeps the fence on failed commit', () => {
  const f = fixture();
  expect(() =>
    retireMissingRuntime(f.home, f.identity, () => {
      expect(f.ledger.readGrant(f.identity)).toBeNull();
      throw new Error('application commit failed');
    }),
  ).toThrow('application commit failed');
  expect(JSON.parse(readFileSync(join(f.directory, 'retired.json'), 'utf8')).identity).toEqual(
    f.identity,
  );
  expect(retireMissingRuntime(f.home, f.identity, () => {})).toBe('retired');
});

it('service cleanup retires credit even when no service record was ever published', async () => {
  const f = fixture();
  expect(await removeRuntimeService(f.home, f.identity)).toBe('absent');
  expect(f.ledger.readGrant(f.identity)).toBeNull();
  expect(existsSync(join(f.directory, 'retired.json'))).toBe(true);
});

it('blocks purge for any exact or unknown outstanding grant, including zero-byte rows', () => {
  const f = fixture();
  f.ledger.compareGrant(f.identity, 1, 0);
  expect(() => requireNoRuntimeMemoryGrants(f.home)).toThrow('must retire');
  expect(existsSync(join(f.directory, 'launch.json'))).toBe(true);
});

it('refuses changed launch evidence after syncing a fence, retaining the entire grant', () => {
  const f = fixture(),
    claims = f.claim();
  f.fence();
  vi.mocked(fsyncSync).mockImplementationOnce((fd) => {
    actualFs.fsyncSync(fd);
    const file = join(f.directory, 'launch.json');
    const launch = JSON.parse(readFileSync(file, 'utf8'));
    launch.identity.launch_id = randomUUID();
    atomicPrivateJson(file, launch);
  });
  expect(() => f.ledger.retireGrant(f.identity, claims)).toThrow('evidence changed');
  expect(f.ledger.readGrant(f.identity)?.bytes).toBe(100);
});

it('reclaims a row at the admission ceiling instead of imposing a lifetime runtime limit', () => {
  const f = fixture(),
    claims = f.claim();
  const db = new Database(join(f.home, 'runtime-claims/managed-memory.sqlite'));
  try {
    const insert = db.prepare('INSERT INTO grants VALUES (?, ?, ?, 1, 0)');
    db.transaction(() => {
      for (let index = 1; index < HOST_MEMORY_GRANT_ROWS; index++)
        insert.run(randomUUID(), randomUUID(), randomUUID());
    })();
  } finally {
    db.close();
  }
  const next = { runtime_id: randomUUID(), incarnation: randomUUID(), launch_id: randomUUID() };
  expect(f.ledger.compareGrant(next, 0, 0)).toBeNull();
  f.fence();
  expect(f.ledger.retireGrant(f.identity, claims)).toBe(true);
  expect(f.ledger.compareGrant(next, 0, 100)).toEqual({ revision: 1, bytes: 100 });
});

it('does not refund graceful-stop memory until the isolated owning process actually exits', async () => {
  const f = fixture();
  const packageRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  const entry = join(f.home, 'memory-owner.cjs');
  symlinkSync(join(packageRoot, 'node_modules'), join(f.home, 'node_modules'));
  await build({
    stdin: {
      contents: `import { acquireHostClaim } from './src/security/claims.ts';
const owner = acquireHostClaim(process.argv[2], 'runtime:' + process.argv[3]);
globalThis.memoryClaim = acquireHostClaim(process.argv[2], 'runtime-memory:' + process.argv[3]);
owner.release();
process.stdout.write('stopped-but-retained');
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));`,
      resolveDir: packageRoot,
      sourcefile: 'memory-owner.ts',
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
  const child = spawn(process.execPath, [entry, f.home, f.identity.runtime_id], {
    env: { HOME: f.home, PATH: process.env.PATH },
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  const exited = once(child, 'exit');
  try {
    const [ready] = await once(child.stdout, 'data');
    expect(String(ready)).toBe('stopped-but-retained');
    expect(retireMissingRuntime(f.home, f.identity, () => {})).toBe('owned');
    expect(f.ledger.readGrant(f.identity)?.bytes).toBe(100);
    child.stdin.end();
    expect(await exited).toEqual([0, null]);
    expect(retireMissingRuntime(f.home, f.identity, () => {})).toBe('retired');
    expect(f.ledger.readGrant(f.identity)).toBeNull();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
});
