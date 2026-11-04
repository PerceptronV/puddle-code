import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostBackgroundTasks } from '../../../src/host/lifecycle/background.js';

afterEach(() => vi.useRealTimers());

describe('host background upkeep', () => {
  it('coalesces an active job and drains it without replaying skipped triggers', async () => {
    const tasks = new HostBackgroundTasks();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const action = vi.fn(() => blocked);
    expect(tasks.start('fetch', action)).toBe(true);
    expect(tasks.start('fetch', action)).toBe(false);
    const hold = tasks.pause();
    expect(tasks.start('another', action)).toBe(false);
    const drained = vi.fn();
    const drain = hold.drain().then(drained);
    await Promise.resolve();
    expect(action).toHaveBeenCalledOnce();
    expect(drained).not.toHaveBeenCalled();
    release();
    await drain;
    hold.release();
    await tasks.close();
    expect(tasks.start('fetch', action)).toBe(false);
    expect(action).toHaveBeenCalledOnce();
  });

  it('bounds concurrent jobs and lets failed work drain', async () => {
    const tasks = new HostBackgroundTasks();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (let index = 0; index < 64; index++)
      expect(tasks.start(String(index), () => blocked)).toBe(true);
    expect(tasks.start('overflow', async () => {})).toBe(false);
    release();
    const hold = tasks.pause();
    await hold.drain();
    hold.release();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(
        tasks.start('failed', async () => {
          throw new Error('fixture failure');
        }),
      ).toBe(true);
      await tasks.close();
      expect(warning).toHaveBeenCalledOnce();
    } finally {
      warning.mockRestore();
    }
  });

  it('processes a whole large sweep with at most four concurrent workers', async () => {
    const tasks = new HostBackgroundTasks();
    const seen: number[] = [];
    let active = 0;
    let peak = 0;
    const items = Array.from({ length: 100 }, (_, index) => index);
    tasks.startBatch('accounts', items, async (item) => {
      peak = Math.max(peak, ++active);
      await Promise.resolve();
      seen.push(item);
      active--;
    });
    await tasks.close();
    expect(peak).toBe(4);
    expect(seen.sort((a, b) => a - b)).toEqual(items);
  });

  it('keeps shutdown fenced when its bounded drain times out', async () => {
    vi.useFakeTimers();
    const tasks = new HostBackgroundTasks();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    tasks.start('blocked', () => blocked);
    const closing = expect(tasks.close(100)).rejects.toThrow(/deadline/);
    await vi.advanceTimersByTimeAsync(100);
    await closing;
    expect(tasks.start('later', async () => {})).toBe(false);
    release();
    await tasks.close();
  });
});
