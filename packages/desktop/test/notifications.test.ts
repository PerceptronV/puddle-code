import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

const nativeShow = vi.hoisted(() => vi.fn());
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class Notification extends EventEmitter {
    static instances: Notification[] = [];
    static isSupported = vi.fn(() => true);
    show = nativeShow;
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
import { notificationDeliverySchema } from '@puddle/shared';

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
  nativeShow.mockReset();
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

it('retains the exact session destination in the main process across renderer reloads', async () => {
  const target = { project: '0123456789', session: randomUUID() };
  const sent = delivery.show({ ...request, target });
  instances[0].emit('show');
  await sent;
  // No renderer callback map is needed: the native click carries the destination.
  instances[0].emit('click');
  expect(win.webContents.send).toHaveBeenCalledWith(
    'puddle:notification-click',
    request.id,
    target,
  );
  await expect(
    delivery.show({ ...request, target: { project: '../../other', session: target.session } }),
  ).rejects.toThrow();
});

it.each([
  'The operation couldn’t be completed. (UNErrorDomain error 1.)',
  'Error Domain=UNErrorDomain Code=1 "Notifications are not allowed"',
])('explains macOS authorisation failures and retains the native detail: %s', async (error) => {
  const sent = delivery.show(request);
  instances[0].emit('failed', {}, error);
  const result = notificationDeliverySchema.parse(await sent);
  expect(result.state).toBe('failed');
  expect(result.message).toContain('System Settings → Notifications → Puddle');
  expect(result.message).toContain('valid app signature');
  expect(result.message).toContain(error);
  expect(delivery.status()).toEqual(result);

  const retried = delivery.show(request);
  instances[1].emit('show');
  await expect(retried).resolves.toEqual({ state: 'shown', message: null });
  expect(delivery.status().state).toBe('shown');
});

it.each(['UNErrorDomain error 100.', 'OtherErrorDomain error 1.', 'A native failure'])(
  'preserves unrelated native errors: %s',
  async (error) => {
    const sent = delivery.show(request);
    instances[0].emit('failed', {}, error);
    await expect(sent).resolves.toEqual({ state: 'failed', message: error });
  },
);

it('bounds long authorisation errors to the IPC message limit', async () => {
  const sent = delivery.show(request);
  instances[0].emit('failed', {}, `UNErrorDomain error 1. ${'detail '.repeat(100)}`);
  const result = notificationDeliverySchema.parse(await sent);
  expect(result.message).toHaveLength(512);
  expect(result.message).toContain('UNErrorDomain error 1.');
});

it('explains authorisation errors thrown by the native API', async () => {
  nativeShow.mockImplementationOnce(() => {
    throw new Error('UNErrorDomain error 1.');
  });
  const result = await delivery.show(request);
  expect(result.state).toBe('failed');
  expect(result.message).toContain('System Settings → Notifications → Puddle');
  expect(result.message).toContain('UNErrorDomain error 1.');
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
