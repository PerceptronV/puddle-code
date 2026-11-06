import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import type { RuntimeClient } from '../../../src/runtime/transport/client.js';
import { runtimeDatabase } from '../../helpers/runtime-database.js';

it('rechecks only preparing owners, retaining real failure backoff and maintenance admission', async () => {
  const f = runtimeDatabase();
  let gap = false;
  const request = vi.fn(async (message: { t: string }) => {
    if (message.t === 'events')
      return {
        t: 'events',
        page: {
          events: [],
          through: 0,
          more: false,
          gap,
          journal: { cursor: 0, acknowledged: 0, lost_through: 0, persistence_pending: false },
        },
      };
    if (message.t === 'inspect')
      return { t: 'state', state: { state: 'prepared', journal: { cursor: 0 } } };
    throw new Error('Unready owner must not accept a binding');
  });
  const client = Object.assign(new EventEmitter(), { request }) as unknown as RuntimeClient;
  vi.useFakeTimers();
  try {
    await f.reconciler.attach(f.binding.runtime_id, client);
    expect(request).toHaveBeenCalledTimes(2);
    await f.reconciler.refreshPreparing(f.binding.runtime_id);
    expect(request).toHaveBeenCalledTimes(4);
    const hold = f.reconciler.pause();
    await hold.drain();
    await expect(f.reconciler.refreshPreparing(f.binding.runtime_id)).rejects.toThrow(/paused/);
    expect(request).toHaveBeenCalledTimes(4);
    hold.release();
    gap = true;
    await f.reconciler.refreshPreparing(f.binding.runtime_id);
    expect(request).toHaveBeenCalledTimes(5);
    await f.reconciler.refreshPreparing(f.binding.runtime_id);
    expect(request).toHaveBeenCalledTimes(5);
    expect(f.reconciler.pendingIds()).toContain(f.binding.runtime_id);
    expect(f.runtimes.get(f.binding.runtime_id)!.event_cursor).toBe(0);
    await vi.advanceTimersByTimeAsync(999);
    expect(request).toHaveBeenCalledTimes(5);
  } finally {
    await f.reconciler.close();
    f.db.close();
    vi.useRealTimers();
  }
});
