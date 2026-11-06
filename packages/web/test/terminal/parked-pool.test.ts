import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ParkedTerminalPool } from '../../src/features/terminal/parked/pool';

describe('parked terminal budget', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each([1, 10, 50])(
    'keeps the newest three of %i viewers warm after a minute',
    async (count) => {
      const pool = new ParkedTerminalPool();
      const captures = Array.from({ length: count }, () => vi.fn(async () => true));
      const registrations = captures.map((capture) => pool.register(capture));
      for (const registration of registrations) {
        registration.setParked(true);
        await vi.advanceTimersByTimeAsync(1);
      }
      await vi.advanceTimersByTimeAsync(59_000 - count);
      expect(captures.every((capture) => capture.mock.calls.length === 0)).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(captures.map((capture) => capture.mock.calls.length)).toEqual(
        captures.map((_, index) => (index < count - 3 ? 1 : 0)),
      );
      expect(vi.getTimerCount()).toBe(0);
      registrations.forEach((registration) => registration.dispose());
    },
  );

  it('cancels capture on a quick pane move or close', async () => {
    const pool = new ParkedTerminalPool(0);
    const capture = vi.fn(async () => true);
    const moved = pool.register(capture);
    moved.setParked(true);
    await vi.advanceTimersByTimeAsync(59_000);
    moved.setParked(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(capture).not.toHaveBeenCalled();
    moved.setParked(true);
    moved.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('serialises captures and leaves a second between them', async () => {
    const pool = new ParkedTerminalPool(0, 0);
    let finish!: (result: boolean) => void;
    const first = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
    const second = vi.fn(async () => true);
    pool.register(first).setParked(true);
    pool.register(second).setParked(true);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    finish(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(second).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('keeps unsupported or failed captures without a retry loop', async () => {
    const pool = new ParkedTerminalPool(0, 0);
    const unsupported = vi.fn(async () => false);
    const failing = vi.fn(async (): Promise<boolean> => {
      throw new Error('capture');
    });
    const registration = pool.register(unsupported);
    registration.setParked(true);
    pool.register(failing).setParked(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(unsupported).toHaveBeenCalledTimes(1);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    registration.setParked(false);
    registration.setParked(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(unsupported).toHaveBeenCalledTimes(2);
  });
});
