import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { RuntimeBufferBudget } from '../../../src/runtime/resources/budget.js';
import { RuntimeHostAllowance } from '../../../src/runtime/resources/host/allowance.js';

const identity = () => ({
  runtime_id: randomUUID(),
  incarnation: randomUUID(),
  launch_id: randomUUID(),
});
type Identity = ReturnType<typeof identity>;

/** Deterministic commit/reply faults; real cross-process SQLite checks live beside the ledger. */
class Ledger {
  readonly grants = new Map<string, { revision: number; bytes: number }>();
  writes = 0;
  reads = 0;
  unreadable = false;
  fault: 'before' | 'after' | null = null;
  constructor(readonly capacity: number) {}
  readGrant(owner: Identity) {
    this.reads++;
    if (this.unreadable) throw new Error('Ledger unavailable');
    const grant = this.grants.get(owner.runtime_id);
    return grant ? { ...grant } : null;
  }
  compareGrant(owner: Identity, revision: number, bytes: number) {
    this.writes++;
    if (this.fault === 'before') throw new Error('Write refused');
    const previous = this.grants.get(owner.runtime_id) ?? { revision: 0, bytes: 0 };
    const total = [...this.grants.values()].reduce((sum, grant) => sum + grant.bytes, 0);
    if (previous.revision !== revision || total - previous.bytes + bytes > this.capacity)
      return null;
    const next = { revision: revision + 1, bytes };
    this.grants.set(owner.runtime_id, next);
    if (this.fault === 'after') throw new Error('Commit reply lost');
    return { ...next };
  }
}

it('shares one owner grant across buffer domains without disk work for cached allocations', () => {
  const ledger = new Ledger(100);
  const allowance = new RuntimeHostAllowance(ledger, identity(), 20, 5);
  const input = new RuntimeBufferBudget({ bytes: 80, count: 2 }, allowance);
  const output = new RuntimeBufferBudget({ bytes: 80, count: 2 }, allowance);
  const first = input.reserve(13)!;
  const second = output.reserve(7)!;
  expect(ledger.writes).toBe(1);
  expect(ledger.reads).toBe(1);
  expect(allowance.usedBytes).toBe(20);
  expect(input.reserve(81)).toBeNull();
  expect(ledger.writes).toBe(1);
  first();
  first();
  second();
  expect(allowance.usedBytes).toBe(0);
  expect(ledger.writes).toBe(1);
  expect(allowance.trim()).toBe(true);
  expect(allowance.availableBytes).toBe(5);
});

it('admits exact affordable work when rounding spare capacity would exceed the host cap', () => {
  const ledger = new Ledger(30);
  const first = new RuntimeHostAllowance(ledger, identity(), 20, 0);
  const second = new RuntimeHostAllowance(ledger, identity(), 20, 0);
  const release = first.reserve(20)!;
  expect(second.reserve(10)).toBeTypeOf('function');
  expect(second.reserve(1)).toBeNull();
  release();
  expect(first.trim()).toBe(true);
  expect(second.reserve(1)).toBeTypeOf('function');
});

it.each(['before', 'after'] as const)(
  'reconciles a failed growth %s commit without replaying an uncertain increment',
  (fault) => {
    const ledger = new Ledger(100);
    const owner = identity();
    const allowance = new RuntimeHostAllowance(ledger, owner, 20, 0);
    ledger.fault = fault;
    expect(allowance.reserve(10)).toBeNull();
    expect(allowance.usedBytes).toBe(0);
    ledger.fault = null;
    expect(allowance.reserve(10)).toBeTypeOf('function');
    expect(ledger.grants.get(owner.runtime_id)?.bytes).toBe(20);
    expect(ledger.writes).toBe(fault === 'after' ? 1 : 2);
  },
);

it('keeps confirmed spare usable through failed growth and an unreadable ledger', () => {
  const ledger = new Ledger(100);
  const allowance = new RuntimeHostAllowance(ledger, identity(), 20, 0);
  const release = allowance.reserve(10)!;
  ledger.fault = 'after';
  expect(allowance.reserve(20)).toBeNull();
  ledger.unreadable = true;
  expect(allowance.reserve(11)).toBeNull();
  expect(allowance.reserve(10)).toBeTypeOf('function');
  release();
  expect(allowance.usedBytes).toBe(10);
  expect(ledger.writes).toBe(2);
});

it('removes returned capacity locally before another owner can spend a lost shrink reply', () => {
  const ledger = new Ledger(20);
  const first = new RuntimeHostAllowance(ledger, identity(), 20, 0);
  const second = new RuntimeHostAllowance(ledger, identity(), 20, 0);
  first.reserve(20)!();
  ledger.fault = 'after';
  expect(first.trim()).toBe(false);
  expect(first.availableBytes).toBe(0);
  ledger.fault = null;
  expect(second.reserve(20)).toBeTypeOf('function');
  ledger.unreadable = true;
  expect(first.reserve(1)).toBeNull();
  expect(first.usedBytes).toBe(0);
});

it('recovers a failed return without dropping already allocated capacity', () => {
  const ledger = new Ledger(20);
  const allowance = new RuntimeHostAllowance(ledger, identity(), 20, 0);
  const release = allowance.reserve(10)!;
  ledger.fault = 'before';
  expect(allowance.trim()).toBe(false);
  expect(allowance.availableBytes).toBe(0);
  ledger.fault = null;
  expect(allowance.reserve(5)).toBeTypeOf('function');
  expect(ledger.writes).toBe(2);
  release();
  expect(allowance.usedBytes).toBe(5);
});

it('refuses further allocation after an unexpected writer changes the owner grant', () => {
  const ledger = new Ledger(100);
  const owner = identity();
  const allowance = new RuntimeHostAllowance(ledger, owner, 20, 0);
  allowance.reserve(10);
  ledger.fault = 'before';
  expect(allowance.reserve(20)).toBeNull();
  ledger.grants.set(owner.runtime_id, { revision: 99, bytes: 100 });
  ledger.fault = null;
  expect(allowance.reserve(20)).toBeNull();
  expect(allowance.reserve(1)).toBeNull();
  expect(allowance.usedBytes).toBe(10);
});

it('does not consume a child budget when shared admission fails', () => {
  const ledger = new Ledger(5);
  const allowance = new RuntimeHostAllowance(ledger, identity(), 1, 0);
  const budget = new RuntimeBufferBudget({ bytes: 10, count: 2 }, allowance);
  expect(budget.reserve(6)).toBeNull();
  expect(budget.usedBytes).toBe(0);
  expect(budget.usedCount).toBe(0);
  const release = budget.reserve(5)!;
  const action = budget.reserve(0)!;
  expect(budget.reserve(0)).toBeNull();
  release();
  action();
  expect(allowance.usedBytes).toBe(0);
});

it('never retries exact admission after an invalid rounded grant response', () => {
  let writes = 0;
  const ledger = {
    readGrant: () => null,
    compareGrant: (_owner: Identity, revision: number, bytes: number) => {
      writes++;
      return { revision: revision + (writes === 1 ? 99 : 1), bytes };
    },
  };
  const allowance = new RuntimeHostAllowance(ledger, identity(), 20, 0);
  expect(allowance.reserve(10)).toBeNull();
  expect(allowance.usedBytes).toBe(0);
  expect(allowance.reserve(1)).toBeNull();
  expect(writes).toBe(1);
});

it('resizes retained domains without freeing backing still held or overcharging a shrink', () => {
  const ledger = new Ledger(20);
  const allowance = new RuntimeHostAllowance(ledger, identity(), 1, 0);
  const geometry = allowance.retain(15)!;
  const text = allowance.retain(5)!;
  expect(geometry.resize(16)).toBe(false);
  expect(allowance.usedBytes).toBe(20);
  expect(geometry.resize(10)).toBe(true);
  expect(text.resize(10)).toBe(true);
  expect(allowance.usedBytes).toBe(20);
  expect(geometry.resize(-1)).toBe(false);
  geometry.release();
  geometry.release();
  expect(geometry.resize(1)).toBe(false);
  expect(allowance.usedBytes).toBe(10);
  expect(text.resize(0)).toBe(true);
  expect(allowance.usedBytes).toBe(0);
  text.release();
});
