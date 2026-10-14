import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ connect: vi.fn(), privatePath: vi.fn() }));
vi.mock('node:net', () => ({ connect: mocks.connect }));
vi.mock('@puddle/shared/node', async (original) => ({
  ...(await original<object>()),
  privatePath: mocks.privatePath,
}));
import { ipcPath } from '@puddle/shared/node';
import { subscribePushNotifications } from '../src/sessions/push-notifications.js';
import type { SessionService } from '../src/sessions/service.js';

afterEach(() => vi.clearAllMocks());
describe('daemon push signals', () => {
  it('checks the owning profile preferences and sends only an event id over private IPC', () => {
    const socket = Object.assign(new EventEmitter(), {
      setTimeout: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    });
    mocks.connect.mockReturnValue(socket);
    const service = new EventEmitter() as SessionService;
    let preferences: object = { desktop: true, muted_projects: [] };
    const stores = {
      sessions: { get: () => ({ project_id: 'project' }) },
      projects: { get: () => ({ id: 'project', profile_id: '0123456789' }) },
      profiles: { getSettings: () => ({ notifications: preferences }) },
    } as unknown as Parameters<typeof subscribePushNotifications>[2];
    const close = subscribePushNotifications('/tmp/puddle-notify-test', service, stores);
    const event = {
      t: 'agent-notification',
      id: randomUUID(),
      session: randomUUID(),
      reason: 'waiting_input',
    };
    service.emit('agent-notification', event);
    socket.emit('connect');
    expect(socket.end).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ t: 'notify', id: event.id }) + '\n',
    );
    expect(mocks.privatePath).toHaveBeenCalledWith(
      ipcPath('/tmp/puddle-notify-test', 'remote-0123456789'),
    );
    preferences = { desktop: false };
    service.emit('agent-notification', event);
    preferences = { desktop: true, muted_projects: ['project'] };
    service.emit('agent-notification', event);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    close();
    expect(socket.destroy).toHaveBeenCalled();
    service.emit('agent-notification', event);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
  });
});
