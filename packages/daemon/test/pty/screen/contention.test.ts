import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeBufferBudget } from '../../../src/runtime/resources/budget.js';
import {
  ScreenRetainedBudget,
  SCREEN_RETAINED_LIMITS,
} from '../../../src/pty/screen/retained/budget.js';
import { ScreenSnapshotWork } from '../../../src/pty/screen/work.js';
import { SCREEN_LIMITS } from '../../../src/pty/screen/limits.js';
import { TerminalScreenStateStore } from '../../../src/pty/terminal-screen-state.js';
import { screenContention as fixture } from '../../helpers/pty/contention.js';
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('screen admission under ledger contention', () => {
  it.each(['forget', 'release'] as const)(
    'does not resurrect a stream after %s cancels pre-geometry admission',
    async (method) => {
      const { ledger, allowance } = fixture();
      ledger.busy = 1;
      const store = new TerminalScreenStateStore(undefined, undefined, { allowance });
      const prepared = store.prepare('removed', 'agent', 80, 24).catch((error) => error as Error);
      await Promise.resolve();
      expect(ledger.busy).toBe(0);
      if (method === 'forget') await store.forget('removed');
      else await store.release('removed', 'agent');
      expect(await prepared).toMatchObject({ message: expect.stringContaining('cancelled') });
      expect(allowance.usedBytes).toBe(0);
      await store.prepare('removed', 'agent', 80, 24);
      expect(await store.snapshot('removed', 'agent')).toBeNull();
      await store.closeAll();
      expect(allowance.usedBytes).toBe(0);
    },
  );
  it.each(['geometry', 'initial queue'])(
    'prepares the first screen through %s CAS contention without a canonical gap',
    async (phase) => {
      const { ledger, allowance } = fixture();
      const baseline = allowance.reserve(4 * 1024 * 1024 - (phase === 'geometry' ? 128 : 0))!;
      const health = vi.fn();
      const store = new TerminalScreenStateStore(undefined, health, { allowance });
      ledger.busy = 2;
      try {
        const prepared = store.prepare('first', 'agent', 80, 24);
        expect(store.prepare('first', 'agent', 80, 24)).toBe(prepared);
        await prepared;
        expect(ledger.busy).toBe(0);
        store.write('first', 'agent', 'canonical after busy');
        expect(await store.snapshot('first', 'agent')).toContain('canonical after busy');
        expect(health).not.toHaveBeenCalledWith(true);
      } finally {
        await store.closeAll();
        baseline();
      }
      expect(allowance.usedBytes).toBe(0);
    },
  );

  it('refuses definitive initial exhaustion without poisoning a later admitted screen', async () => {
    const { allowance } = fixture(4 * 1024 * 1024);
    const baseline = allowance.reserve(4 * 1024 * 1024)!;
    const health = vi.fn();
    const store = new TerminalScreenStateStore(undefined, health, { allowance });
    try {
      await expect(store.prepare('first', 'agent', 80, 24)).rejects.toThrow('capacity exhausted');
      expect(health).not.toHaveBeenCalled();
      baseline();
      await store.prepare('first', 'agent', 80, 24);
      expect(await store.snapshot('first', 'agent')).toBeNull();
    } finally {
      await store.closeAll();
      baseline();
    }
    expect(allowance.usedBytes).toBe(0);
  });

  it('bounds metadata-only preparations and cancels them before shutdown refunds allocations', async () => {
    vi.useFakeTimers();
    const { ledger, allowance } = fixture();
    ledger.busy = Infinity;
    const health = vi.fn();
    const store = new TerminalScreenStateStore(undefined, health, { allowance });
    const pending = Array.from({ length: SCREEN_LIMITS.waitingOperations }, (_, index) =>
      store.prepare(`pending-${index}`, 'agent', 80, 24).catch((error) => error as Error),
    );
    await expect(store.prepare('overflow', 'agent', 80, 24)).rejects.toThrow('capacity');
    const closing = store.closeAll();
    await vi.advanceTimersByTimeAsync(50);
    await closing;
    expect(
      (await Promise.all(pending)).every(
        (error) => error instanceof Error && /cancelled/.test(error.message),
      ),
    ).toBe(true);
    expect(allowance.usedBytes).toBe(0);
    expect(health).not.toHaveBeenCalled();
  });

  it('ends an unresolved initial admission attempt at the bounded deadline', async () => {
    vi.useFakeTimers();
    const { ledger, allowance } = fixture();
    ledger.busy = Infinity;
    const store = new TerminalScreenStateStore(undefined, undefined, { allowance });
    const prepared = store.prepare('pending', 'agent', 80, 24).catch((error) => error as Error);
    await vi.advanceTimersByTimeAsync(5100);
    expect(await prepared).toMatchObject({
      message: expect.stringContaining('capacity exhausted'),
    });
    await store.closeAll();
    expect(allowance.usedBytes).toBe(0);
  });
  it('rechecks local burst ownership after yielding without overcommitting or gapping', async () => {
    const { ledger, allowance } = fixture();
    const retained = new ScreenRetainedBudget(undefined, allowance);
    ledger.busy = 1;
    let firstReady = false;
    const first = retained.acquireBurst(SCREEN_RETAINED_LIMITS.burstBytes).then((release) => {
      firstReady = true;
      return release;
    });
    const second = await retained.acquireBurst(SCREEN_RETAINED_LIMITS.burstBytes);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(firstReady).toBe(false);
    expect(retained.burstBytes).toBe(SCREEN_RETAINED_LIMITS.burstBytes);
    second();
    (await first)();
    expect(retained.burstBytes).toBe(0);
    expect(allowance.usedBytes).toBe(0);
  });

  it('retries uncertain snapshot admission within the existing bounded waiter pool', async () => {
    const { ledger, allowance } = fixture();
    const budget = new RuntimeBufferBudget(
      { bytes: SCREEN_LIMITS.transientBytes, count: 2 },
      allowance,
    );
    const work = new ScreenSnapshotWork(budget);
    ledger.busy = 2;
    const pending = work.acquire();
    expect(budget.usedBytes).toBe(0);
    const release = await pending;
    expect(budget.usedBytes).toBe(SCREEN_LIMITS.operationBytes);
    release();
    expect(allowance.usedBytes).toBe(0);
  });

  it('bounds unresolved work waiters and their retry deadline', async () => {
    vi.useFakeTimers();
    const { ledger, allowance } = fixture();
    ledger.busy = Infinity;
    const work = new ScreenSnapshotWork(
      new RuntimeBufferBudget({ bytes: SCREEN_LIMITS.transientBytes, count: 2 }, allowance),
    );
    const waiting = Array.from({ length: SCREEN_LIMITS.waitingOperations }, () =>
      work.acquire().catch((error) => error as Error),
    );
    await expect(work.acquire()).rejects.toThrow('capacity');
    await vi.advanceTimersByTimeAsync(5100);
    const errors = await Promise.all(waiting);
    expect(errors.every((error) => error instanceof Error && /timed out/.test(error.message))).toBe(
      true,
    );
    expect(work.budget.usedBytes).toBe(0);
  });

  it('does not reserve snapshot work for a missing initial file or poison later output', async () => {
    const home = mkdtempSync(join(tmpdir(), 'puddle-screen-admission-'));
    const health = vi.fn();
    const work = new RuntimeBufferBudget({ bytes: SCREEN_LIMITS.transientBytes, count: 2 });
    const reserve = vi.spyOn(work, 'reserve').mockReturnValueOnce(null);
    const store = new TerminalScreenStateStore(home, health, { transientBudget: work });
    try {
      store.resize('fresh', 'agent', 80, 24);
      expect(await store.snapshot('fresh', 'agent')).toBeNull();
      expect(reserve).not.toHaveBeenCalled();
      expect(health).not.toHaveBeenCalledWith(true);
      reserve.mockRestore();
      store.write('fresh', 'agent', 'still healthy');
      expect(await store.snapshot('fresh', 'agent')).toContain('still healthy');
    } finally {
      reserve.mockRestore();
      await store.closeAll();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
