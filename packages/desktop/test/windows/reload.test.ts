import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { afterEach, expect, it, vi } from 'vitest';
import { reloadContents } from '../../src/windows/reload.js';

afterEach(() => vi.useRealTimers());
function contents() {
  return Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
  });
}

it('keeps reload pending through subframe failures and finishes only when the document loads', async () => {
  const page = contents();
  const done = vi.fn();
  const pending = reloadContents(page as unknown as WebContents, true).then(done);
  expect(page.reloadIgnoringCache).toHaveBeenCalledOnce();
  expect(page.reload).not.toHaveBeenCalled();
  page.emit('did-fail-load', {}, -2, 'iframe failed', 'http://localhost/frame', false);
  await Promise.resolve();
  expect(done).not.toHaveBeenCalled();
  page.emit('did-finish-load');
  await pending;
  expect(done).toHaveBeenCalledOnce();
  expect(page.eventNames()).toEqual([]);
});

it.each(['failure', 'destroyed', 'timeout'])(
  'bounds a reload %s and removes native listeners',
  async (reason) => {
    vi.useFakeTimers();
    const page = contents();
    const rejected = expect(reloadContents(page as unknown as WebContents)).rejects.toThrow();
    if (reason === 'failure')
      page.emit('did-fail-load', {}, -2, 'failed', 'http://localhost/', true);
    else if (reason === 'destroyed') page.emit('destroyed');
    else await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(page.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  },
);
