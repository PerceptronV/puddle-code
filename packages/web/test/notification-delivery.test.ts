import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ worker: vi.fn(), bridge: vi.fn(() => null) }));
vi.mock('../src/lib/desktop', () => ({ desktopBridge: mocks.bridge }));
vi.mock('../src/lib/notification-worker', () => ({ notificationWorker: mocks.worker }));
import { deliverNotification } from '../src/lib/notification-delivery';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
const request = { id: 'test', title: 'Agent', body: 'Finished' };

describe('browser notification delivery', () => {
  it('uses persistent service-worker notifications where the mobile constructor throws', async () => {
    const constructor = vi.fn(() => {
      throw new TypeError('Illegal constructor');
    });
    vi.stubGlobal('Notification', Object.assign(constructor, { permission: 'granted' }));
    const showNotification = vi.fn(async () => {});
    const subscribe = vi.fn();
    vi.stubGlobal('navigator', { serviceWorker: { addEventListener: subscribe } });
    mocks.worker.mockResolvedValue({ showNotification });
    const click = vi.fn();
    await expect(deliverNotification(request, click)).resolves.toEqual({
      state: 'shown',
      message: null,
    });
    expect(constructor).not.toHaveBeenCalled();
    expect(showNotification).toHaveBeenCalledExactlyOnceWith('Agent', {
      body: 'Finished',
      tag: 'test',
      silent: true,
    });
    subscribe.mock.calls[0]![1]({ data: { t: 'notification-click', id: 'test' } });
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('surfaces rejected permission and service-worker delivery errors', async () => {
    vi.stubGlobal('Notification', { permission: 'denied' });
    expect((await deliverNotification(request, () => {})).state).toBe('failed');
    expect(mocks.worker).not.toHaveBeenCalled();
    vi.stubGlobal('Notification', { permission: 'granted' });
    mocks.worker.mockResolvedValue({
      showNotification: async () => {
        throw new Error('System denied delivery');
      },
    });
    await expect(deliverNotification(request, () => {})).resolves.toEqual({
      state: 'failed',
      message: 'System denied delivery',
    });
  });

  it('catches browser constructor failures when no service worker is available', async () => {
    mocks.worker.mockResolvedValue(null);
    vi.stubGlobal(
      'Notification',
      Object.assign(
        function () {
          throw new Error('Unsupported');
        },
        { permission: 'granted' },
      ),
    );
    await expect(deliverNotification(request, () => {})).resolves.toEqual({
      state: 'failed',
      message: 'Unsupported',
    });
  });
});
