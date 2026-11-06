import { afterEach, expect, it, vi } from 'vitest';
import { TerminalScreenStateStore } from '../../../src/pty/terminal-screen-state.js';
import { serialiseScreen } from '../../../src/pty/screen/serialise.js';
import { RuntimeBufferBudget } from '../../../src/runtime/resources/budget.js';
import { SCREEN_LIMITS } from '../../../src/pty/screen/limits.js';
import { ScreenAllowance } from '../../helpers/pty/allowance.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PtyManager } from '../../../src/pty/pty-manager.js';
import type { LogStore } from '../../../src/logs/log-store.js';

vi.mock('../../../src/pty/screen/serialise.js', async (original) => {
  const actual = await original<typeof import('../../../src/pty/screen/serialise.js')>();
  return { ...actual, serialiseScreen: vi.fn(actual.serialiseScreen) };
});
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

it('shares real owner captures with repeated geometry while preserving restore and queued resize order', async () => {
  const home = mkdtempSync(join(tmpdir(), 'puddle-shared-capture-'));
  mkdirSync(join(home, 'synthetic'));
  writeFileSync(
    join(home, 'synthetic', 'agent.terminal.json'),
    JSON.stringify({ version: 1, cols: 40, rows: 4, data: 'restored synthetic history' }),
  );
  const manager = new PtyManager({} as LogStore, undefined, home);
  const sizes: number[][] = [];
  const capture = (cols: number, rows: number) =>
    manager.canonicalSnapshot('synthetic', 'agent', cols, rows, () => {
      const terminal = vi.mocked(serialiseScreen).mock.calls.at(-1)![0];
      sizes.push([terminal.cols, terminal.rows]);
    });
  try {
    const values = await Promise.all([
      capture(120, 32), // same as the initial emulator, different from the saved file
      capture(120, 32),
      capture(80, 24),
      capture(80, 24),
      capture(120, 32), // must not reuse the earlier geometry's boundary
    ]);
    expect(values.every((data) => data.includes('restored synthetic history'))).toBe(true);
    expect(sizes).toEqual([
      [120, 32],
      [120, 32],
      [80, 24],
      [80, 24],
      [120, 32],
    ]);
    expect(serialiseScreen).toHaveBeenCalledTimes(3);
  } finally {
    await manager.closeTerminalStates();
    rmSync(home, { recursive: true, force: true });
  }
});

it('shares one pending capture and transfers each consumer before releasing work credit', async () => {
  const transient = new RuntimeBufferBudget({ bytes: SCREEN_LIMITS.transientBytes, count: 2 });
  const store = new TerminalScreenStateStore(undefined, undefined, { transientBudget: transient });
  const accepted: string[] = [];
  try {
    store.write('synthetic', 'agent', 'shared boundary');
    const values = await Promise.all(
      Array.from({ length: 4 }, () =>
        store.snapshot('synthetic', 'agent', (data) => {
          expect(transient.usedCount).toBe(1);
          accepted.push(data);
        }),
      ),
    );
    expect(new Set(values).size).toBe(1);
    expect(accepted).toEqual(values);
    expect(serialiseScreen).toHaveBeenCalledTimes(1);
    expect(transient.usedCount).toBe(0);
    await store.snapshot('synthetic', 'agent');
    expect(serialiseScreen).toHaveBeenCalledTimes(2); // no retained ANSI cache
  } finally {
    await store.closeAll();
  }
});

it('never shares across queued output, resize, alternate-screen changes or different terminals', async () => {
  const store = new TerminalScreenStateStore();
  try {
    store.write('synthetic', 'agent', 'before');
    const first = store.snapshot('synthetic', 'agent');
    store.write('synthetic', 'agent', ' after');
    const second = store.snapshot('synthetic', 'agent');
    store.resize('synthetic', 'agent', 20, 4);
    const resized = store.snapshot('synthetic', 'agent');
    store.write('synthetic', 'agent', '\x1b[?1049h\x1b[Halternate');
    const alternate = store.snapshot('synthetic', 'agent');
    store.write('other', 'agent', 'different terminal');
    const other = store.snapshot('other', 'agent');
    const values = await Promise.all([first, second, resized, alternate, other]);
    expect(values[0]).toContain('before');
    expect(values[0]).not.toContain('after');
    expect(values[1]).toContain('before after');
    expect(values[3]).toContain('alternate');
    expect(values[4]).toContain('different terminal');
    expect(serialiseScreen).toHaveBeenCalledTimes(5);
  } finally {
    await store.closeAll();
  }
});

it('isolates a refused consumer and queues a re-entrant capture separately', async () => {
  const store = new TerminalScreenStateStore();
  let reentrant: Promise<string | null> | undefined;
  try {
    store.write('synthetic', 'agent', 'canonical');
    const refused = store.snapshot('synthetic', 'agent', () => {
      throw new Error('consumer admission');
    });
    const accepted = store.snapshot('synthetic', 'agent', () => {
      reentrant = store.snapshot('synthetic', 'agent');
    });
    await expect(refused).rejects.toThrow('consumer admission');
    expect(await accepted).toContain('canonical');
    expect(await reentrant).toContain('canonical');
    expect(serialiseScreen).toHaveBeenCalledTimes(2);
  } finally {
    await store.closeAll();
  }
});

it('bounds shared readers and refunds all metadata without poisoning canonical parsing', async () => {
  const allowance = new ScreenAllowance(128 * 1024 * 1024);
  const store = new TerminalScreenStateStore(undefined, undefined, { allowance });
  try {
    store.write('synthetic', 'agent', 'admitted');
    const requests = Array.from({ length: SCREEN_LIMITS.captureActions + 1 }, () =>
      store.snapshot('synthetic', 'agent'),
    );
    const settled = await Promise.allSettled(requests);
    expect(settled.filter((row) => row.status === 'fulfilled')).toHaveLength(
      SCREEN_LIMITS.captureActions,
    );
    expect(settled.at(-1)).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: expect.stringContaining('capacity') }),
    });
    expect(serialiseScreen).toHaveBeenCalledTimes(1);
    store.write('synthetic', 'agent', ' still healthy');
    expect(await store.snapshot('synthetic', 'agent')).toContain('still healthy');
  } finally {
    await store.closeAll();
  }
  expect(allowance.used).toBe(0);
});

it('rejects all cancelled readers and rejects later hand-offs after a re-entrant input gap', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const parser = new RuntimeBufferBudget({ bytes: 1024, count: 64 });
  const store = new TerminalScreenStateStore(undefined, undefined, { parserBudget: parser });
  try {
    store.write('synthetic', 'agent', 'before gap');
    const first = store.snapshot('synthetic', 'agent', () =>
      store.write('synthetic', 'agent', 'x'.repeat(1024)),
    );
    const second = store.snapshot('synthetic', 'agent');
    const results = await Promise.allSettled([first, second]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1]).toMatchObject({ status: 'rejected' });
    store.write('other', 'agent', 'queued');
    const cancelled = [store.snapshot('other', 'agent'), store.snapshot('other', 'agent')];
    store.write('other', 'agent', 'x'.repeat(1024));
    expect((await Promise.allSettled(cancelled)).every((row) => row.status === 'rejected')).toBe(
      true,
    );
  } finally {
    await store.closeAll();
  }
});
