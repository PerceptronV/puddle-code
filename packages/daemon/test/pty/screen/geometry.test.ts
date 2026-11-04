import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ScreenRetainedBudget,
  SCREEN_RETAINED_LIMITS,
} from '../../../src/pty/screen/retained/budget.js';
import { coreOf } from '../../../src/pty/screen/retained/internals.js';
import { TerminalScreenStateStore } from '../../../src/pty/terminal-screen-state.js';
import { retainedScreen as screen, screenLines } from '../../helpers/pty/retained-screen.js';

describe('incremental canonical geometry', () => {
  it('reserves only viewports for 32 fresh terminals instead of their future history', () => {
    const budget = new ScreenRetainedBudget();
    const screens = Array.from({ length: 32 }, () => screen({}, budget, 120, 32));
    try {
      expect(budget.geometryBytes).toBe(32 * budget.geometry(120, 32, 0));
      expect(budget.geometryBytes).toBeLessThan(17 * 1024 * 1024);
      expect(screens.every((f) => f.guard.lease.scrollback === 0)).toBe(true);
      expect(screens.every((f) => f.terminal.options.scrollback === 0)).toBe(true);
    } finally {
      for (const f of screens) f.guard.dispose();
    }
    expect(budget.geometryBytes).toBe(0);
  });

  it('charges small history increments before xterm grows its actual circular array', async () => {
    const f = screen({ scrollback: 2000 });
    const lines = coreOf(f.terminal)._bufferService.buffers.normal.lines as unknown as {
      maxLength: number;
    };
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(lines), 'maxLength')!.set!;
    const observations: Array<{ capacity: number; charged: number }> = [];
    vi.spyOn(lines, 'maxLength', 'set').mockImplementation((value) => {
      observations.push({ capacity: value, charged: f.budget.geometryBytes });
      setter.call(lines, value);
    });
    try {
      await f.guard.write('history\r\n'.repeat(150));
      expect(observations.length).toBeGreaterThan(1);
      expect(observations.map((value) => value.capacity)).toEqual([67, 131, 195]);
      for (const value of observations)
        expect(value.charged).toBe(f.budget.geometry(20, 3, value.capacity - 3));
      expect(f.guard.lease.scrollback).toBe(192);
      expect(f.failures).toEqual([]);
    } finally {
      f.guard.dispose();
    }
  });

  it('preserves a pending-wrap cursor and saved horizontal cursor when history grows', async () => {
    const f = screen({ scrollback: 100 }, undefined, 4, 2);
    try {
      await f.guard.write('abcd\x1b7');
      const normal = coreOf(f.terminal)._bufferService.buffers.normal;
      expect(normal.x).toBe(4);
      expect(normal.savedX).toBe(4);
      expect(f.budget.grow(f.guard.lease)).toBe(true);
      expect(normal.x).toBe(4);
      expect(normal.savedX).toBe(4);
      await f.guard.write('e');
      expect(screenLines(f.terminal)).toEqual(['abcd', 'e   ']);
    } finally {
      f.guard.dispose();
    }
  });

  it('rolls over admitted history without a canonical gap when optional growth is refused', async () => {
    const line = 20 * SCREEN_RETAINED_LIMITS.cellBytes + SCREEN_RETAINED_LIMITS.lineBytes;
    const budget = new ScreenRetainedBudget({
      ...SCREEN_RETAINED_LIMITS,
      geometryBytes: line * 11,
    });
    const f = screen({}, budget);
    try {
      await f.guard.write(Array.from({ length: 100 }, (_, index) => `line-${index}\r\n`).join(''));
      expect(f.guard.lease.scrollback).toBe(4);
      expect(f.terminal.buffer.normal.length).toBeLessThanOrEqual(7);
      expect(screenLines(f.terminal).join('\n')).toContain('line-99');
      expect(f.budget.geometryBytes).toBeLessThanOrEqual(line * 11);
      expect(f.failures).toEqual([]);
    } finally {
      f.guard.dispose();
    }
  });

  it('uses returned capacity for later growth instead of permanently capping a second screen', async () => {
    const line = 20 * SCREEN_RETAINED_LIMITS.cellBytes + SCREEN_RETAINED_LIMITS.lineBytes;
    const budget = new ScreenRetainedBudget({
      ...SCREEN_RETAINED_LIMITS,
      geometryBytes: line * 18,
    });
    const first = screen({}, budget);
    const second = screen({}, budget);
    try {
      await first.guard.write('first\r\n'.repeat(30));
      await second.guard.write('second\r\n'.repeat(30));
      expect(second.guard.lease.scrollback).toBe(0);
      first.guard.dispose();
      await second.guard.write('new history\r\n'.repeat(30));
      expect(second.guard.lease.scrollback).toBeGreaterThan(0);
      expect(second.failures).toEqual([]);
    } finally {
      first.guard.dispose();
      second.guard.dispose();
    }
  });

  it('trims only necessary history for a new idle viewport and preserves it when capacity fits', async () => {
    for (const capacity of [64 * 1024, 1024 * 1024]) {
      const budget = new ScreenRetainedBudget({
        ...SCREEN_RETAINED_LIMITS,
        geometryBytes: capacity,
      });
      const first = screen({}, budget);
      let second: ReturnType<typeof screen> | undefined;
      try {
        await first.guard.write('busy history\r\n'.repeat(100));
        const before = first.guard.lease.scrollback;
        const excess = Math.max(0, budget.geometryBytes + budget.geometry(20, 3, 0) - capacity);
        const necessary = Math.ceil(excess / budget.line(20));
        second = screen({}, budget);
        expect(first.guard.lease.scrollback).toBe(before - necessary);
        expect(second.guard.lease.scrollback).toBe(0);
        expect(budget.geometryBytes).toBeLessThanOrEqual(capacity);
        if (capacity === 64 * 1024) expect(necessary).toBe(7);
        else expect(necessary).toBe(0);
      } finally {
        first.guard.dispose();
        second?.guard.dispose();
      }
    }
  });

  it('keeps peak backing width charged through shrink, alternate use, reset and regrowth', async () => {
    const f = screen({ scrollback: 2000 }, undefined, 40, 4);
    try {
      await f.guard.write('history\r\n'.repeat(200));
      await f.guard.resize(20, 2);
      f.guard.lease.trim(2);
      await f.guard.write('regrown\r\n'.repeat(100));
      expect(f.guard.lease.cols).toBe(40);
      expect(f.guard.lease.rows).toBe(4);
      expect(f.guard.lease.scrollback).toBeGreaterThan(2);
      const admitted = f.budget.geometryBytes;
      await f.guard.write('\x1b[?1049h' + 'alternate\r\n'.repeat(200) + '\x1b[?1049l');
      expect(f.budget.geometryBytes).toBe(admitted);
      await f.guard.write('\x1bc');
      expect(f.guard.lease.scrollback).toBe(0);
      expect(f.budget.geometryBytes).toBe(f.budget.geometry(40, 4, 0));
      await f.guard.write('after reset\r\n'.repeat(100));
      expect(f.guard.lease.scrollback).toBeGreaterThan(0);
      expect(f.failures).toEqual([]);
    } finally {
      f.guard.dispose();
    }
  });

  it('keeps an uncertain capacity publication charged until disposal', () => {
    const budget = new ScreenRetainedBudget();
    const lease = budget.admit(20, 3);
    lease.attach(() => {
      throw new Error('capacity publication failed');
    });
    expect(() => budget.grow(lease)).toThrow('publication failed');
    expect(budget.geometryBytes).toBe(budget.geometry(20, 3, 64));
    lease.dispose();
    expect(budget.geometryBytes).toBe(0);
  });

  it('restores long saved history through incremental admission', async () => {
    const home = mkdtempSync(join(tmpdir(), 'puddle-lazy-geometry-'));
    const budget = new ScreenRetainedBudget();
    const store = new TerminalScreenStateStore(home, undefined, { retainedBudget: budget });
    try {
      mkdirSync(join(home, 'session'), { mode: 0o700 });
      writeFileSync(
        join(home, 'session', 'agent.terminal.json'),
        JSON.stringify({
          version: 1,
          cols: 120,
          rows: 32,
          data: Array.from(
            { length: 5000 },
            (_, index) => `line-${String(index).padStart(4, '0')}\r\n`,
          ).join(''),
        }),
        { mode: 0o600 },
      );
      const restored = await store.snapshot('session', 'agent');
      expect(restored).toContain('line-0000');
      expect(restored).toContain('line-4999');
      expect(budget.geometryBytes).toBeGreaterThan(32 * 1024 * 1024);
      expect(budget.geometryBytes).toBeLessThan(48 * 1024 * 1024);
    } finally {
      await store.closeAll();
      expect(budget.geometryBytes).toBe(0);
      rmSync(home, { recursive: true, force: true });
    }
  });
});
