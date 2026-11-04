import { expect, it, vi } from 'vitest';
import { HostAdmission } from '../../../src/host/lifecycle/admission.js';
import { HostUpdatePause } from '../../../src/updates/maintenance/pause.js';

it('drains launches before pausing the discovery and reconciliation they require', async () => {
  const clients = new HostAdmission();
  const launches = new HostAdmission();
  const discovery = new HostAdmission();
  const reconciliation = new HostAdmission();
  const endClient = clients.enter();
  const endLaunch = launches.enter();
  const order: string[] = [];
  const participant = (name: string, admission: HostAdmission) => ({
    pause() {
      order.push(`pause:${name}`);
      const hold = admission.pause();
      return {
        drain: hold.drain,
        release() {
          order.push(`release:${name}`);
          hold.release();
        },
      };
    },
  });
  const pause = new HostUpdatePause([
    [participant('clients', clients)],
    [participant('launches', launches)],
    [participant('discovery', discovery)],
    [participant('reconciliation', reconciliation)],
  ]);
  const pending = pause.acquire();
  expect(() => clients.enter()).toThrow();
  await expect(pause.acquire()).rejects.toThrow('already paused');
  expect(order).toEqual(['pause:clients']);
  discovery.assertOpen();
  reconciliation.assertOpen();
  endClient();
  await vi.waitFor(() => expect(order).toContain('pause:launches'));
  expect(() => launches.enter()).toThrow();
  discovery.assertOpen();
  reconciliation.assertOpen();
  endLaunch();
  const held = await pending;
  expect(() => reconciliation.enter()).toThrow();
  held.release();
  held.release();
  expect(order).toEqual([
    'pause:clients',
    'pause:launches',
    'pause:discovery',
    'pause:reconciliation',
    'release:reconciliation',
    'release:discovery',
    'release:launches',
    'release:clients',
  ]);
  const next = await pause.acquire();
  held.release(); // A stale release cannot reopen a subsequent inspection.
  expect(() => clients.enter()).toThrow();
  next.release();
  clients.assertOpen();
});

it('releases every acquired hold on a failed phase without pausing later participants', async () => {
  const clients = new HostAdmission();
  const first = clients.pause.bind(clients);
  const released = vi.fn();
  const later = vi.fn();
  const pause = new HostUpdatePause([
    [
      { pause: first },
      {
        pause: () => ({
          drain: async () => {
            throw new Error('Writer drain failed');
          },
          release: released,
        }),
      },
    ],
    [{ pause: later }],
  ]);
  await expect(pause.acquire()).rejects.toThrow('Writer drain failed');
  clients.assertOpen();
  expect(released).toHaveBeenCalledOnce();
  expect(later).not.toHaveBeenCalled();
});

it('shares a bounded deadline and never reopens participants already closed by shutdown', async () => {
  const first = new HostAdmission();
  const second = new HostAdmission();
  const release = first.enter();
  const pause = new HostUpdatePause([[first], [second]]);
  try {
    await expect(pause.acquire(10)).rejects.toThrow('deadline');
  } finally {
    release();
  }
  first.assertOpen();
  second.assertOpen();
  const held = await pause.acquire();
  first.close();
  held.release();
  expect(() => first.enter()).toThrow();
  second.assertOpen();
});
