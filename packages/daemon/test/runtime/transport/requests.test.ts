import { expect, it, vi } from 'vitest';
import { RuntimeBufferBudget } from '../../../src/runtime/resources/budget.js';
import { RuntimeRequestQueue } from '../../../src/runtime/transport/requests.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it('charges multiple connection queues against one allowance while retaining separate ordering', async () => {
  const budget = new RuntimeBufferBudget({ bytes: 12, count: 3 });
  const failed = vi.fn();
  const first = new RuntimeRequestQueue(budget, () => true, failed);
  const second = new RuntimeRequestQueue(budget, () => true, failed);
  const blocked = gate();
  const completed: string[] = [];
  expect(
    first.enqueue(4, async () => {
      await blocked.promise;
      completed.push('first');
    }),
  ).toBe(true);
  expect(
    first.enqueue(4, async () => {
      completed.push('after-first');
    }),
  ).toBe(true);
  expect(
    second.enqueue(4, async () => {
      completed.push('second');
    }),
  ).toBe(true);
  expect(
    second.enqueue(1, async () => {
      completed.push('refused');
    }),
  ).toBe(false);
  expect(budget.usedBytes).toBe(12);
  await second.settled;
  expect(completed).toEqual(['second']);
  expect(budget.usedBytes).toBe(8);
  blocked.release();
  await first.settled;
  expect(completed).toEqual(['second', 'first', 'after-first']);
  expect(budget.usedBytes).toBe(0);
  expect(failed).not.toHaveBeenCalled();
});

it('keeps closed-connection work charged until its closures settle and never dispatches it again', async () => {
  const budget = new RuntimeBufferBudget({ bytes: 8, count: 2 });
  let connected = true;
  const queue = new RuntimeRequestQueue(budget, () => connected, vi.fn());
  const blocked = gate();
  const entered = gate();
  const later = vi.fn(async () => {});
  queue.enqueue(4, async () => {
    entered.release();
    await blocked.promise;
  });
  queue.enqueue(4, later);
  await entered.promise;
  connected = false;
  expect(queue.enqueue(1, later)).toBe(false);
  expect(budget.usedBytes).toBe(8);
  const replacement = new RuntimeRequestQueue(budget, () => true, vi.fn());
  expect(replacement.enqueue(4, later)).toBe(false);
  blocked.release();
  await queue.settled;
  expect(later).not.toHaveBeenCalled();
  expect(replacement.enqueue(4, later)).toBe(true);
  await replacement.settled;
  expect(later).toHaveBeenCalledOnce();
  expect(budget.usedCount).toBe(0);
});

it('releases failed work and closes only that connection before its remaining requests dispatch', async () => {
  const budget = new RuntimeBufferBudget({ bytes: 10, count: 2 });
  let connected = true;
  const failed = vi.fn(() => {
    connected = false;
  });
  const queue = new RuntimeRequestQueue(budget, () => connected, failed);
  const later = vi.fn(async () => {});
  queue.enqueue(3, async () => {
    throw new Error('reply failed');
  });
  queue.enqueue(3, later);
  await queue.settled;
  expect(failed).toHaveBeenCalledOnce();
  expect(later).not.toHaveBeenCalled();
  expect(budget.usedBytes).toBe(0);
  const healthy = new RuntimeRequestQueue(budget, () => true, vi.fn());
  expect(healthy.enqueue(10, later)).toBe(true);
  await healthy.settled;
  expect(later).toHaveBeenCalledOnce();
});

it('limits tiny queued requests by count independently of their encoded byte size', async () => {
  const budget = new RuntimeBufferBudget({ bytes: 100, count: 2 });
  const blocked = gate();
  const a = new RuntimeRequestQueue(budget, () => true, vi.fn());
  const b = new RuntimeRequestQueue(budget, () => true, vi.fn());
  expect(a.enqueue(1, () => blocked.promise)).toBe(true);
  expect(b.enqueue(1, () => blocked.promise)).toBe(true);
  expect(b.enqueue(1, async () => {})).toBe(false);
  blocked.release();
  await Promise.all([a.settled, b.settled]);
  expect(budget.usedCount).toBe(0);
});
