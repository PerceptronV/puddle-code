import { expect, it } from 'vitest';
import { RuntimeBufferBudget } from '../../../src/runtime/resources/budget.js';

it('bounds bytes and zero-byte reservations independently with idempotent release', () => {
  const capacity = { bytes: 10, count: 2 };
  const budget = new RuntimeBufferBudget(capacity);
  capacity.bytes = 100;
  capacity.count = 100;
  const first = budget.reserve(10)!;
  expect(budget.reserve(1)).toBeNull();
  const second = budget.reserve(0)!;
  expect(budget.reserve(0)).toBeNull();
  first();
  first();
  expect(budget.usedBytes).toBe(0);
  expect(budget.usedCount).toBe(1);
  second();
  expect(budget.usedCount).toBe(0);
  expect(budget.reserve(11)).toBeNull();
});

it('rejects invalid capacities and reservation arithmetic', () => {
  for (const value of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => new RuntimeBufferBudget({ bytes: value, count: 1 })).toThrow();
    expect(() => new RuntimeBufferBudget({ bytes: 1, count: value })).toThrow();
    const budget = new RuntimeBufferBudget({ bytes: 10, count: 10 });
    expect(budget.reserve(value)).toBeNull();
    expect(budget.reserve(0, value)).toBeNull();
    expect(budget.usedBytes).toBe(0);
    expect(budget.usedCount).toBe(0);
  }
});
