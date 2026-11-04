import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RuntimeLaunch } from '@puddle/shared';
import type {
  HostMemoryGrant,
  HostMemoryIdentity,
} from '../../../../src/runtime/resources/host/ledger.js';
import {
  runtimeEssentialMemoryBytes,
  HOST_MEMORY_SPARE_BYTES,
} from '../../../../src/runtime/resources/host/policy.js';

// Only lifecycle I/O is replaced. The production owner, grant cache, absolute
// revisions and idle timer run together with deterministic transient failures.
const state = vi.hoisted(() => ({
  launch: null as RuntimeLaunch | null,
  grant: null as HostMemoryGrant | null,
  read: vi.fn<() => HostMemoryGrant>(),
  compare:
    vi.fn<
      (identity: HostMemoryIdentity, revision: number, bytes: number) => HostMemoryGrant | null
    >(),
  close: vi.fn(),
}));
vi.mock('../../../../src/security/claims.js', () => ({
  acquireHostClaim: () => ({ release() {} }),
}));
vi.mock('../../../../src/runtime/ownership/storage.js', () => ({
  runtimeDirectory: () => '/isolated/runtime',
  readRuntimeJson: (file: string) => {
    if (file.endsWith('/launch.json')) return state.launch;
    throw Object.assign(new Error('No retirement fence'), { code: 'ENOENT' });
  },
}));
vi.mock('../../../../src/runtime/resources/host/ledger.js', () => ({
  HostMemoryLedger: {
    openExisting: () => ({
      readGrant: state.read,
      compareGrant: state.compare,
      close: state.close,
    }),
  },
}));
const busy = () => Object.assign(new Error('Temporary writer contention'), { code: 'SQLITE_BUSY' });
let owner: import('../../../../src/runtime/resources/host/owner.js').RuntimeOwnerMemory;
let essential: number;
const read = () => ({ ...state.grant! });
const compare = (_identity: HostMemoryIdentity, revision: number, bytes: number) => {
  if (revision !== state.grant!.revision) return null;
  state.grant = { revision: revision + 1, bytes };
  return read();
};
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  state.launch = {
    format: 1,
    identity: {
      runtime_id: randomUUID(),
      incarnation: randomUUID(),
      launch_id: randomUUID(),
      profile_id: '1111111111',
      project_id: '2222222222',
      session_id: randomUUID(),
      canonical_worktree_path: '/isolated',
    },
    secret: 'a'.repeat(64),
    main: { file: '/bin/sh', args: [], cwd: '/isolated', env: {}, cols: 80, rows: 24 },
  };
  essential = runtimeEssentialMemoryBytes(Buffer.byteLength(JSON.stringify(state.launch)));
  state.grant = { revision: 1, bytes: essential };
  state.read.mockReset().mockImplementation(read);
  state.compare.mockReset().mockImplementation(compare);
  state.close.mockReset();
  const { RuntimeOwnerMemory } = await import('../../../../src/runtime/resources/host/owner.js');
  owner = await RuntimeOwnerMemory.open('/isolated', state.launch.identity.runtime_id);
});
afterEach(() => {
  owner?.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function burst() {
  const release = owner.allowance.reserve(8 * 1024 * 1024)!;
  expect(release).not.toBeNull();
  release();
  expect(vi.getTimerCount()).toBe(1);
  state.read.mockClear();
  state.compare.mockClear();
}

it('retries an idle shrink after contention without requiring further output or releases', () => {
  burst();
  const original = read();
  state.compare.mockImplementationOnce(() => {
    throw busy();
  });
  vi.advanceTimersByTime(1000);
  expect(state.grant).toEqual(original);
  expect(owner.allowance.availableBytes).toBe(HOST_MEMORY_SPARE_BYTES);
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(1999);
  expect(state.compare).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);
  expect(state.compare).toHaveBeenCalledTimes(2);
  expect(state.grant?.bytes).toBe(essential + HOST_MEMORY_SPARE_BYTES);
  expect(owner.allowance.usedBytes).toBe(essential);
  expect(vi.getTimerCount()).toBe(0);
});

it('observes a committed lost shrink reply rather than issuing another compare-and-set', () => {
  burst();
  state.compare.mockImplementationOnce((identity, revision, bytes) => {
    compare(identity, revision, bytes);
    throw new Error('Lost acknowledgement after commit');
  });
  vi.advanceTimersByTime(1000);
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(2000);
  expect(state.compare).toHaveBeenCalledTimes(1);
  expect(state.read).toHaveBeenCalledTimes(1);
  expect(state.grant?.bytes).toBe(essential + HOST_MEMORY_SPARE_BYTES);
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps one retry timer with capped backoff while observation remains unavailable', () => {
  const timer = vi.spyOn(globalThis, 'setTimeout');
  burst();
  state.compare.mockImplementationOnce(() => {
    throw busy();
  });
  state.read.mockImplementation(() => {
    throw busy();
  });
  for (const delay of [1000, 2000, 4000, 8000, 16_000, 30_000]) {
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(delay);
  }
  expect(timer.mock.calls.map((call) => call[1])).toEqual([
    1000, 2000, 4000, 8000, 16_000, 30_000, 30_000,
  ]);
  expect(state.compare).toHaveBeenCalledTimes(1);
  state.read.mockImplementation(read);
  vi.advanceTimersByTime(30_000);
  expect(state.grant?.bytes).toBe(essential + HOST_MEMORY_SPARE_BYTES);
  expect(vi.getTimerCount()).toBe(0);
});

it('cancels a failed-trim retry on close without refunding still-retained essential memory', () => {
  const lateRelease = owner.allowance.reserve(1)!;
  burst();
  state.compare.mockImplementationOnce(() => {
    throw busy();
  });
  vi.advanceTimersByTime(1000);
  const retained = read();
  owner.close();
  lateRelease();
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(60_000);
  expect(state.compare).toHaveBeenCalledTimes(1);
  expect(state.grant).toEqual(retained);
  expect(owner.allowance.usedBytes).toBe(essential);
  expect(owner.allowance.reserve(1)).toBeNull();
  expect(state.close).toHaveBeenCalledTimes(1);
});
