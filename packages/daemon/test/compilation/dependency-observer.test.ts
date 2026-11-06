import { EventEmitter } from 'node:events';
import type { FSWatcher, WatchListener } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const fs = vi.hoisted(() => ({
  stat: vi.fn(),
  watch: vi.fn(),
  statSync: vi.fn(() => {
    throw new Error('synchronous stat');
  }),
}));
vi.mock('node:fs', () => ({ watch: fs.watch, statSync: fs.statSync }));
vi.mock('node:fs/promises', () => ({ stat: fs.stat }));
import { DependencyObserver } from '../../src/compilation/dependency-observer.js';
import { DependencyWatcher } from '../../src/compilation/dependency-watcher.js';

const observers: DependencyObserver[] = [];
const values = new Map<string, number>();
const watched = new Map<string, { listener: WatchListener<string>; handle: FSWatcher }>();
let inflight = 0,
  maxInflight = 0;
const observer = () => {
  const value = new DependencyObserver();
  observers.push(value);
  return value;
};
beforeEach(() => {
  vi.useFakeTimers();
  values.clear();
  watched.clear();
  inflight = maxInflight = 0;
  fs.stat.mockReset();
  fs.watch.mockReset();
  fs.statSync.mockClear();
  fs.stat.mockImplementation(async (path: string) => {
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    await Promise.resolve();
    inflight--;
    const revision = values.get(path) ?? 1;
    if (revision === 0) throw new Error('missing');
    return { dev: 1, ino: revision, size: revision, mtimeMs: revision, ctimeMs: revision };
  });
  fs.watch.mockImplementation((path: string, listener: WatchListener<string>) => {
    const handle = new EventEmitter() as FSWatcher;
    handle.close = vi.fn(() => {
      if (watched.get(path)?.handle === handle) watched.delete(path);
    });
    watched.set(path, { handle, listener });
    return handle;
  });
});
afterEach(() => {
  for (const value of observers.splice(0)) value.dispose();
  vi.useRealTimers();
});
const flush = () => vi.advanceTimersByTimeAsync(0);

it.each([3, 1000])(
  'shares %i overlapping dependencies, bounds initial/verification concurrency and avoids high-frequency stats',
  async (count) => {
    const shared = observer();
    const paths = Array.from({ length: count }, (_, i) => `/project/${i}`);
    const clients = Array.from({ length: 3 }, () => shared.subscribe(paths, vi.fn()));
    await Promise.all(clients.map((c) => c.ready));
    expect(fs.statSync).not.toHaveBeenCalled();
    expect(fs.stat).toHaveBeenCalledTimes(count);
    expect(maxInflight).toBeLessThanOrEqual(8);
    expect(fs.watch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fs.stat).toHaveBeenCalledTimes(count);
    await vi.advanceTimersByTimeAsync(9000);
    expect(fs.stat).toHaveBeenCalledTimes(count * 2);
    clients[0]!.close();
    clients[1]!.close();
    expect(watched.size).toBe(1);
    clients[2]!.close();
    expect(watched.size).toBe(0);
    const calls = fs.stat.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fs.stat).toHaveBeenCalledTimes(calls);
  },
);

it('filters unrelated watch events, shares invalidation and retains baselines across target replacement', async () => {
  const shared = observer();
  const changed = vi.fn(),
    secondChanged = vi.fn();
  const first = new DependencyWatcher(shared, changed),
    second = new DependencyWatcher(shared, secondChanged);
  await Promise.all([first.replace(['/project/a']), second.replace(['/project/a'])]);
  watched.get('/project')!.listener('change', 'unrelated');
  await vi.advanceTimersByTimeAsync(400);
  expect(changed).not.toHaveBeenCalled();
  values.set('/project/a', 2);
  watched.get('/project')!.listener('rename', 'a');
  await flush();
  // Replacement must keep a pending invalidation rather than clearing it.
  await first.replace(['/project/a']);
  await vi.advanceTimersByTimeAsync(350);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(secondChanged).toHaveBeenCalledTimes(1);
  expect(fs.watch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(changed).toHaveBeenCalledTimes(1);
  first.close();
  second.close();
});

it('detects silent VM/network changes, deletion and recreation without watch events', async () => {
  const shared = observer();
  const changed = vi.fn();
  const target = new DependencyWatcher(shared, changed);
  await target.replace(['/project/a']);
  for (const value of [2, 0, 3]) {
    values.set('/project/a', value);
    await vi.advanceTimersByTimeAsync(11_000);
  }
  expect(changed).toHaveBeenCalledTimes(3);
});

it('uses a faster bounded fallback on unavailable watches and recovers after directory recreation', async () => {
  const shared = observer();
  const changed = vi.fn();
  const normalWatch = fs.watch.getMockImplementation()!;
  fs.watch.mockImplementation(() => {
    throw new Error('missing directory');
  });
  values.set('/project/a', 0);
  const target = new DependencyWatcher(shared, changed);
  await target.replace(['/project/a']);
  values.set('/project/a', 2);
  await vi.advanceTimersByTimeAsync(1400);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(fs.stat.mock.calls.length).toBeLessThanOrEqual(3);
  fs.watch.mockImplementation(normalWatch);
  await vi.advanceTimersByTimeAsync(4000);
  expect(watched.size).toBe(1);
  watched.get('/project')!.handle.emit('error', new Error('watch failed'));
  values.set('/project/a', 3);
  await vi.advanceTimersByTimeAsync(2000);
  expect(changed).toHaveBeenCalledTimes(2);
});

it('renews directory handles while keeping unchanged signatures and shared references', async () => {
  const shared = observer();
  const changed = vi.fn();
  const subscription = shared.subscribe(['/project/a'], changed);
  await subscription.ready;
  const handle = watched.get('/project')!.handle;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(handle.close).toHaveBeenCalledTimes(1);
  expect(fs.watch).toHaveBeenCalledTimes(2);
  expect(changed).not.toHaveBeenCalled();
});

it('discards stale stat completions after replacement/disposal and cancels pending debounce', async () => {
  let finish!: (value: unknown) => void;
  fs.stat.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  const shared = observer();
  const changed = vi.fn();
  const target = new DependencyWatcher(shared, changed);
  const old = target.replace(['/old/a']);
  const next = target.replace(['/new/a']);
  finish({ dev: 1, ino: 1, size: 1, mtimeMs: 1, ctimeMs: 1 });
  expect(await old).toBe(false);
  expect(await next).toBe(true);
  watched.get('/new')!.listener('change', 'a');
  target.close();
  shared.dispose();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(changed).not.toHaveBeenCalled();
  expect(watched.size).toBe(0);
});
