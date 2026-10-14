import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class Notification extends EventEmitter {
    static instances: Notification[] = [];
    static isSupported = vi.fn(() => true);
    show = vi.fn();
    close = vi.fn(() => this.emit('close'));
    constructor() {
      super();
      Notification.instances.push(this);
    }
  }
  return { Notification };
});
import { Notification, type BrowserWindow } from 'electron';
import { DesktopNotifications } from '../src/notifications.js';

const instances = (Notification as unknown as { instances: Notification[] }).instances;
const win = {
  isDestroyed: () => false,
  webContents: Object.assign(new EventEmitter(), { send: vi.fn() }),
} as unknown as BrowserWindow;
const raise = vi.fn();
let delivery: DesktopNotifications;
const request = { id: 'session-one', title: 'Agent', body: 'Waiting for input' };
beforeEach(() => {
  vi.useFakeTimers();
  instances.length = 0;
  vi.clearAllMocks();
  delivery = new DesktopNotifications(win, raise);
});
afterEach(() => {
  delivery.close();
  vi.useRealTimers();
});

it('waits for the native result and focuses the originating window on click', async () => {
  expect(delivery.status().state).toBe('unverified');
  const sent = delivery.show(request);
  expect(instances[0].show).toHaveBeenCalled();
  instances[0].emit('show');
  await expect(sent).resolves.toEqual({ state: 'shown', message: null });
  instances[0].emit('click');
  expect(raise).toHaveBeenCalledOnce();
  expect(win.webContents.send).toHaveBeenCalledWith('puddle:notification-click', request.id);
});

it('reports a native failure instead of claiming permission is granted', async () => {
  const sent = delivery.show(request);
  instances[0].emit('failed', {}, 'Application is not signed');
  await expect(sent).resolves.toEqual({ state: 'failed', message: 'Application is not signed' });
  expect(delivery.status().state).toBe('failed');
});

it('leaves unconfirmed delivery unverified and disposes pending requests on close', async () => {
  const sent = delivery.show(request);
  await vi.advanceTimersByTimeAsync(5000);
  await expect(sent).resolves.toMatchObject({ state: 'unverified' });
  const pending = delivery.show({ ...request, id: 'another' });
  delivery.close();
  await expect(pending).resolves.toMatchObject({ state: 'failed' });
  instances[1].emit('click');
  expect(raise).not.toHaveBeenCalled();
});

it('rejects malformed IPC before creating a notification', async () => {
  await expect(delivery.show({ ...request, url: 'https://example.com' })).rejects.toThrow();
  expect(instances).toHaveLength(0);
});
