import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { HostMemoryLedger } from '../../../../src/runtime/resources/host/ledger.js';
import { reserveRuntimeLaunchMemory } from '../../../../src/runtime/resources/host/bootstrap.js';
import {
  initialHostMemoryCapacity,
  runtimeEssentialMemoryBytes,
} from '../../../../src/runtime/resources/host/policy.js';

const MIB = 1024 * 1024;
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture(capacity: number) {
  const home = mkdtempSync(join(tmpdir(), 'puddle-memory-policy-'));
  homes.push(home);
  const identity = {
    runtime_id: randomUUID(),
    incarnation: randomUUID(),
    launch_id: randomUUID(),
    profile_id: '1111111111',
    project_id: '2222222222',
    session_id: randomUUID(),
    canonical_worktree_path: home,
  };
  HostMemoryLedger.initialise(home, capacity).close();
  return { home, identity };
}

it('derives a stable initial ceiling from physical/constrained capacity, not free memory', () => {
  expect(initialHostMemoryCapacity(16 * 1024 * MIB, 0)).toBe(4 * 1024 * MIB);
  expect(initialHostMemoryCapacity(64 * 1024 * MIB, 0)).toBe(8 * 1024 * MIB);
  expect(initialHostMemoryCapacity(64 * 1024 * MIB, 4 * 1024 * MIB)).toBe(1024 * MIB);
  expect(initialHostMemoryCapacity(8 * 1024 * MIB, 64 * 1024 * MIB)).toBe(2 * 1024 * MIB);
  expect(() => initialHostMemoryCapacity(NaN, 0)).toThrow('capacity');
  expect(runtimeEssentialMemoryBytes(1024)).toBe(40 * MIB + 8192);
  expect(() => runtimeEssentialMemoryBytes(0)).toThrow('charge');
});

it('preserves the sealed host capacity and identity when bootstrap policy changes', () => {
  const { home } = fixture(128 * MIB);
  const original = HostMemoryLedger.openExisting(home)!;
  const instance = original.instanceId;
  original.close();
  const changed = HostMemoryLedger.initialise(home, 512 * MIB);
  try {
    expect(changed.capacityBytes).toBe(128 * MIB);
    expect(changed.instanceId).toBe(instance);
  } finally {
    changed.close();
  }
});

it('durably admits essential launch capacity without overwriting an earlier dispatch', () => {
  const { home, identity } = fixture(128 * MIB);
  reserveRuntimeLaunchMemory(home, identity, 1024);
  expect(() => reserveRuntimeLaunchMemory(home, identity, 2048)).toThrow('already exists');
  const ledger = HostMemoryLedger.openExisting(home)!;
  try {
    expect(ledger.readGrant(identity)).toEqual({
      revision: 1,
      bytes: runtimeEssentialMemoryBytes(1024),
    });
  } finally {
    ledger.close();
  }
});

it('refuses new launch capacity without inserting a partial grant', () => {
  const { home, identity } = fixture(40 * MIB);
  expect(() => reserveRuntimeLaunchMemory(home, identity, 1024)).toThrow('exhausted');
  const ledger = HostMemoryLedger.openExisting(home)!;
  try {
    ledger.requireEmpty();
  } finally {
    ledger.close();
  }
});
