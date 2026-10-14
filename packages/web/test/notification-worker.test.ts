import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../public/notification-worker.js', import.meta.url), 'utf8');
function worker(indexedDB = new IDBFactory()) {
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const showNotification = vi.fn(async () => {});
  const openWindow = vi.fn(async () => {});
  const client = {
    id: 'app-window',
    frameType: 'top-level',
    url: 'https://app.example.test/',
    focus: vi.fn(async () => {}),
    postMessage: vi.fn(),
  };
  const windows = [client];
  runInNewContext(source, {
    indexedDB,
    URL,
    Date,
    self: {
      location: { origin: 'https://app.example.test' },
      registration: { showNotification },
      clients: { matchAll: async () => windows, openWindow, claim: async () => {} },
      addEventListener: (name: string, handler: (event: Record<string, unknown>) => void) =>
        handlers.set(name, handler),
    },
  });
  const emit = async (name: string, event: Record<string, unknown>) => {
    let pending = Promise.resolve();
    handlers.get(name)!({
      ...event,
      waitUntil: (task: Promise<void>) => {
        pending = task;
      },
    });
    await pending;
  };
  const push = (id: string, host = randomUUID()) =>
    emit('push', { data: { json: () => ({ id, host }) } });
  const live = (id: string) =>
    emit('message', {
      data: {
        t: 'show-notification',
        request: { id: `puddle-event-${id}`, title: 'Agent', body: 'Finished' },
      },
      source: client,
      ports: [{ postMessage: vi.fn() }],
    });
  return { emit, push, live, showNotification, indexedDB, client, windows, openWindow };
}

describe('notification worker', () => {
  it('suppresses duplicated live events but fulfils the visible-notification promise for every push', async () => {
    const f = worker();
    const id = randomUUID();
    await Promise.all([f.push(id), f.live(id), f.live(id)]);
    expect(f.showNotification).toHaveBeenCalledTimes(1);
    const restarted = worker(f.indexedDB);
    await restarted.live(id);
    expect(restarted.showNotification).not.toHaveBeenCalled();
    await restarted.push(id);
    expect(restarted.showNotification).toHaveBeenCalledTimes(1);
  });

  it('does not suppress a retry after failed notification delivery', async () => {
    const f = worker();
    const id = randomUUID();
    f.showNotification.mockRejectedValueOnce(new Error('Permission denied'));
    await expect(f.push(id)).rejects.toThrow('Permission denied');
    await f.push(id);
    expect(f.showNotification).toHaveBeenCalledTimes(2);
  });

  it('rejects untrusted message sources and invalid push payloads', async () => {
    const f = worker();
    await f.emit('message', {
      data: { t: 'show-notification', request: { id: 'test', title: 'Agent', body: 'Finished' } },
      source: { url: 'https://other.example.test/' },
      ports: [],
    });
    await f.emit('push', { data: { json: () => ({ id: 'invalid', host: 'invalid' }) } });
    expect(f.showNotification).not.toHaveBeenCalled();
  });

  it('focuses an existing app on click, or opens only the host identifier on a cold start', async () => {
    const f = worker();
    const host = randomUUID();
    const notification = { tag: 'puddle-event-test', data: { host }, close: vi.fn() };
    await f.emit('notificationclick', { notification });
    expect(f.client.focus).toHaveBeenCalledTimes(1);
    expect(f.client.postMessage).toHaveBeenCalledWith({
      t: 'notification-click',
      id: notification.tag,
      host,
    });
    f.windows.length = 0;
    await f.emit('notificationclick', { notification });
    expect(f.openWindow).toHaveBeenCalledWith(`/?notificationHost=${host}`);
  });
});
