import { expect, it, vi } from 'vitest';
import { WindowNavigations } from '../../../src/windows/hosts/navigation.js';

it('serialises one host, coalesces duplicates and lets another host continue', async () => {
  const queue = new WindowNavigations();
  const gate = Promise.withResolvers<void>();
  const first = queue.run('a', 'refresh', () => gate.promise);
  expect(queue.run('a', 'refresh', vi.fn())).toBe(first);
  const reload = vi.fn().mockResolvedValue(undefined);
  const second = queue.run('a', 'reload', reload);
  const other = vi.fn().mockResolvedValue(undefined);
  await queue.run('b', 'reload', other);
  expect(other).toHaveBeenCalledOnce();
  expect(reload).not.toHaveBeenCalled();
  const drained = vi.fn();
  const draining = queue.drain().then(drained);
  gate.resolve();
  await Promise.all([first, second, draining]);
  expect(reload).toHaveBeenCalledOnce();
  expect(drained).toHaveBeenCalledOnce();
  expect(queue.busy('a')).toBe(false);
});

it('does not let a failed operation poison the next explicit navigation', async () => {
  const queue = new WindowNavigations();
  const failure = queue.run('a', 'reload', async () => {
    throw new Error('save failed');
  });
  const next = vi.fn().mockResolvedValue(undefined);
  const recovery = queue.run('a', 'refresh', next);
  await expect(failure).rejects.toThrow('save failed');
  await recovery;
  await queue.wait('a');
  expect(next).toHaveBeenCalledOnce();
  expect(queue.busy('a')).toBe(false);
});
