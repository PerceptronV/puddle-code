import { describe, expect, it, vi } from 'vitest';
import headless from '@xterm/headless';
import { RuntimeBufferBudget } from '../../../src/runtime/resources/budget.js';
import {
  ScreenRetainedBudget,
  SCREEN_RETAINED_LIMITS,
} from '../../../src/pty/screen/retained/budget.js';
import { SCREEN_LIMITS } from '../../../src/pty/screen/limits.js';
import { ScreenSnapshotWork } from '../../../src/pty/screen/work.js';
import { TerminalScreenStateStore } from '../../../src/pty/terminal-screen-state.js';
import { ScreenAllowance } from '../../helpers/pty/allowance.js';
import { retainedScreen as screen, screenLines } from '../../helpers/pty/retained-screen.js';
import { coreOf } from '../../../src/pty/screen/retained/internals.js';

describe('enclosing screen allowance', () => {
  it('returns a new retained allocation when terminal initialisation fails', async () => {
    const allowance = new ScreenAllowance(64 * 1024 * 1024);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const addon = vi.spyOn(headless.Terminal.prototype, 'loadAddon').mockImplementationOnce(() => {
      throw new Error('Initialisation fault');
    });
    const store = new TerminalScreenStateStore(undefined, undefined, { allowance });
    try {
      expect(() => store.write('failed', 'agent', 'x')).not.toThrow();
      expect(allowance.used).toBe(0);
      store.write('healthy', 'agent', 'healthy after failure');
      expect(await store.snapshot('healthy', 'agent')).toContain('healthy after failure');
    } finally {
      await store.closeAll();
      addon.mockRestore();
      warning.mockRestore();
    }
    expect(allowance.used).toBe(0);
  });

  it('admits before backing growth and returns capacity only after a verified trim', async () => {
    const allowance = new ScreenAllowance(64 * 1024 * 1024);
    const budget = new ScreenRetainedBudget(undefined, allowance);
    const f = screen({}, budget);
    const lines = coreOf(f.terminal)._bufferService.buffers.normal.lines as unknown as {
      maxLength: number;
    };
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(lines), 'maxLength')!.set!;
    const observations: Array<{ capacity: number; used: number }> = [];
    vi.spyOn(lines, 'maxLength', 'set').mockImplementation((value) => {
      observations.push({ capacity: value, used: allowance.used });
      setter.call(lines, value);
    });
    try {
      await f.guard.write('grown\r\n'.repeat(10));
      expect(observations).toEqual([
        {
          capacity: 67,
          used:
            budget.geometry(20, 3, 64) +
            SCREEN_RETAINED_LIMITS.screenControlBytes +
            SCREEN_RETAINED_LIMITS.burstBytes,
        },
      ]);
      const before = allowance.used;
      f.guard.lease.trim(0);
      expect(observations.at(-1)).toEqual({ capacity: 3, used: before });
      expect(allowance.used).toBe(
        budget.geometry(20, 3, 0) + SCREEN_RETAINED_LIMITS.screenControlBytes,
      );
    } finally {
      f.guard.dispose();
    }
    expect(allowance.used).toBe(0);
  });

  it('shares geometry, control and parsing while refused optional history rolls over', async () => {
    const local = new ScreenRetainedBudget();
    const baseline = local.geometry(20, 3, 0) + SCREEN_RETAINED_LIMITS.screenControlBytes;
    const allowance = new ScreenAllowance(baseline + SCREEN_RETAINED_LIMITS.burstBytes);
    let now = 0;
    const budget = new ScreenRetainedBudget(undefined, allowance, () => now);
    const f = screen({}, budget);
    try {
      expect(allowance.used).toBe(baseline);
      await f.guard.write('ordinary\r\n'.repeat(100));
      expect(f.guard.lease.scrollback).toBe(0);
      expect(screenLines(f.terminal).join('\n')).toContain('ordinary');
      expect(f.failures).toEqual([]);
      expect(allowance.used).toBe(baseline);
      expect(allowance.refused).toBe(1);
      await f.guard.write('still rolling\r\n'.repeat(500));
      expect(allowance.refused).toBe(1);
      allowance.capacity += 64 * budget.line(20);
      now = 1001;
      await f.guard.write('growing\r\n'.repeat(100));
      expect(f.guard.lease.scrollback).toBe(64);
      expect(allowance.used).toBe(baseline + 64 * budget.line(20));
      f.guard.lease.trim(0);
      expect(allowance.used).toBe(baseline);
    } finally {
      f.guard.dispose();
    }
    expect(allowance.used).toBe(0);
  });

  it('charges retained Unicode to the same allocation and returns it only after inspection/disposal', async () => {
    const allowance = new ScreenAllowance(64 * 1024 * 1024);
    const budget = new ScreenRetainedBudget(
      { ...SCREEN_RETAINED_LIMITS, variableBytes: 2048, scrollback: 1 },
      allowance,
    );
    const f = screen({}, budget, 4, 1);
    try {
      for (let index = 0; index < 100; index++) await f.guard.write('e\u0301\r\n');
      expect(f.failures).toEqual([]);
      expect(allowance.used).toBe(
        budget.geometryBytes + budget.variableBytes + SCREEN_RETAINED_LIMITS.screenControlBytes,
      );
      expect(budget.variableBytes).toBeGreaterThan(0);
      expect(budget.variableBytes).toBeLessThanOrEqual(2048);
    } finally {
      f.guard.dispose();
      f.guard.dispose();
    }
    expect(allowance.used).toBe(0);
  });

  it('keeps refused essential screen admission inside the store boundary', async () => {
    const allowance = new ScreenAllowance(1);
    const health = vi.fn();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new TerminalScreenStateStore(undefined, health, { allowance });
    try {
      expect(() => store.resize('session', 'agent', 80, 24)).not.toThrow();
      expect(() => store.write('session', 'agent', 'live PTY delivery')).not.toThrow();
      await expect(store.snapshot('session', 'agent')).rejects.toThrow(/unavailable/);
      expect(health).toHaveBeenCalledWith(true);
      expect(allowance.used).toBe(0);
    } finally {
      await store.closeAll();
      warning.mockRestore();
    }
  });

  it('charges parser queue closures to the same allowance before input dispatch', async () => {
    const local = new ScreenRetainedBudget();
    const allowance = new ScreenAllowance(
      local.geometry(120, 32, 0) + SCREEN_RETAINED_LIMITS.screenControlBytes + 128,
    );
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new TerminalScreenStateStore(undefined, undefined, { allowance });
    try {
      // The already queued load action holds the final128bytes. The next input
      // action must be refused even though its independent local budget fits.
      expect(() => store.write('session', 'agent', 'x')).not.toThrow();
      await expect(store.snapshot('session', 'agent')).rejects.toThrow(/unavailable/);
      await vi.waitFor(() => expect(allowance.used).toBe(0));
    } finally {
      await store.closeAll();
      warning.mockRestore();
    }
  });

  it('uses the enclosing allowance for input actions, captures and snapshot work', async () => {
    const allowance = new ScreenAllowance(32 * 1024 * 1024);
    const store = new TerminalScreenStateStore(undefined, undefined, { allowance });
    try {
      store.write('session', 'agent', 'still healthy');
      // Input/parse fit, but the 48MiB snapshot operation cannot be admitted.
      await expect(store.snapshot('session', 'agent')).rejects.toThrow(/work capacity/);
      expect(allowance.admitted).toContain(SCREEN_RETAINED_LIMITS.burstBytes);
      allowance.capacity = 64 * 1024 * 1024;
      expect(await store.snapshot('session', 'agent')).toContain('still healthy');
      expect(allowance.admitted).toContain(SCREEN_LIMITS.operationBytes);
      allowance.blocked = true;
      // Capture refusal must not fence otherwise complete canonical input.
      await expect(store.snapshot('session', 'agent')).rejects.toThrow(/capacity/);
      allowance.blocked = false;
      expect(await store.snapshot('session', 'agent')).toContain('still healthy');
    } finally {
      allowance.blocked = false;
      await store.closeAll();
    }
    expect(allowance.used).toBe(0);
  });

  it('rejects global snapshot refusal without local holders and wakes refused local waiters', async () => {
    const allowance = new ScreenAllowance(0);
    const budget = new RuntimeBufferBudget(
      { bytes: SCREEN_LIMITS.transientBytes, count: 2 },
      allowance,
    );
    const work = new ScreenSnapshotWork(budget);
    await expect(work.acquire()).rejects.toThrow(/capacity/);
    allowance.capacity = SCREEN_LIMITS.operationBytes;
    const first = await work.acquire();
    const waiting = work.acquire();
    const rejected = expect(waiting).rejects.toThrow(/enclosing capacity/);
    allowance.blocked = true;
    expect(first).not.toThrow();
    await rejected;
    expect(budget.usedCount).toBe(0);
    expect(allowance.used).toBe(0);
  });

  it('does not strand parse waiters when global allowance disappears after local work', async () => {
    const allowance = new ScreenAllowance(SCREEN_RETAINED_LIMITS.burstBytes);
    const budget = new ScreenRetainedBudget(undefined, allowance);
    const first = await budget.acquireBurst(SCREEN_RETAINED_LIMITS.burstBytes);
    const waiting = budget.acquireBurst(SCREEN_RETAINED_LIMITS.burstBytes);
    const rejected = expect(waiting).rejects.toThrow(/host burst capacity/);
    allowance.blocked = true;
    first();
    await rejected;
    expect(budget.burstBytes).toBe(0);
    expect(allowance.used).toBe(0);
    await expect(budget.acquireBurst(1)).rejects.toThrow(/host burst capacity/);
  });
});
