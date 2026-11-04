import { afterEach, expect, it, vi } from 'vitest';
import { MarkerFileSync } from '../../src/sessions/onboarding.js';

const state = vi.hoisted(() => ({ listener: () => {}, close: vi.fn(), watch: vi.fn() }));
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  existsSync: () => true,
  watch: state.watch.mockImplementation((_path: string, listener: () => void) => {
    state.listener = listener;
    return { on: vi.fn(), close: state.close };
  }),
}));

afterEach(() => vi.useRealTimers());

it('cancels marker timers and refuses stale watcher events or late watch installation', () => {
  vi.useFakeTimers();
  // No store method may run: disposal cancels the scheduled synchronisation.
  const sync = new MarkerFileSync({} as ConstructorParameters<typeof MarkerFileSync>[0]);
  sync.watch('session', 1, '/fixture');
  state.listener();
  expect(vi.getTimerCount()).toBe(1);
  sync.dispose();
  state.listener();
  sync.watch('later-session', 1, '/fixture');
  vi.advanceTimersByTime(1000);
  expect(state.close).toHaveBeenCalledOnce();
  expect(state.watch).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
