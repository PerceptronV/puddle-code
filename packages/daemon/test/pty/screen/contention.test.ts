import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeBufferBudget } from '../../../src/runtime/resources/budget.js';
import { RuntimeHostAllowance } from '../../../src/runtime/resources/host/allowance.js';
import {
  ScreenRetainedBudget,
  SCREEN_RETAINED_LIMITS,
} from '../../../src/pty/screen/retained/budget.js';
import { ScreenSnapshotWork } from '../../../src/pty/screen/work.js';
import { SCREEN_LIMITS } from '../../../src/pty/screen/limits.js';
import { TerminalScreenStateStore } from '../../../src/pty/terminal-screen-state.js';

function fixture(capacity = 128 * 1024 * 1024) {
  let grant: { revision: number; bytes: number } | null = null;
  const ledger = {
    busy: 0,
    readGrant: () => grant,
    compareGrant: (_identity: unknown, revision: number, bytes: number) => {
      if (ledger.busy > 0) {
        ledger.busy--;
        throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
      }
      if ((grant?.revision ?? 0) !== revision || bytes > capacity) return null;
      return (grant = { revision: revision + 1, bytes });
    },
  };
  const allowance = new RuntimeHostAllowance(
    ledger,
    { runtime_id: randomUUID(), incarnation: randomUUID(), launch_id: randomUUID() },
    4 * 1024 * 1024,
    0,
  );
  return { ledger, allowance };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('screen admission under ledger contention', () => {
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
