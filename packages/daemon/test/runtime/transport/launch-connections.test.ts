import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import type { RuntimeBinding, RuntimeStore } from '../../../src/db/stores/runtimes.js';
import type { RuntimeClient } from '../../../src/runtime/transport/client.js';
import { RuntimeConnections } from '../../../src/runtime/transport/connections.js';
import { connectRuntimeOwner } from '../../../src/runtime/ownership/discovery.js';
import { acquireRuntimeController } from '../../../src/runtime/ownership/storage.js';

vi.mock('../../../src/runtime/ownership/discovery.js', () => ({ connectRuntimeOwner: vi.fn() }));
vi.mock('../../../src/runtime/ownership/storage.js', () => ({ acquireRuntimeController: vi.fn() }));

it('attaches a new launch without waiting for unrelated owners and coalesces its own probes', async () => {
  const bindings = Array.from(
    { length: 5 },
    (_, index) =>
      ({
        runtime_id: `runtime-${index}`,
        state: 'prepared',
        build: 'fixture',
        protocol_major: 1,
        protocol_minor: 0,
      }) as RuntimeBinding,
  );
  const store = {
    live: () => bindings,
    get: (id: string) => bindings.find((binding) => binding.runtime_id === id) ?? null,
  } as RuntimeStore;
  const release = vi.fn();
  vi.mocked(acquireRuntimeController).mockReturnValue({ record: {}, release } as never);
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const clients = bindings.map(() => {
    const client = new EventEmitter() as RuntimeClient;
    Object.assign(client, {
      state: { build: 'fixture', protocol: { major: 1, minor: 0 } },
      close: vi.fn(() => client.emit('disconnected')),
    });
    return client;
  });
  vi.mocked(connectRuntimeOwner).mockImplementation(async (_home, identity) => {
    const index = bindings.findIndex((binding) => binding.runtime_id === identity.runtime_id);
    if (index < 4) await blocked;
    return clients[index]!;
  });
  const connected = vi.fn();
  const connections = new RuntimeConnections('/unused', store, { connected });
  const scan = connections.connect();
  try {
    await vi.waitFor(() => expect(connectRuntimeOwner).toHaveBeenCalledTimes(4));
    await Promise.all([
      connections.connectOwner('runtime-4'),
      connections.connectOwner('runtime-4'),
    ]);
    expect(connections.get('runtime-4')).toBe(clients[4]);
    expect(connected).toHaveBeenCalledTimes(1);
    expect(connectRuntimeOwner).toHaveBeenCalledTimes(5);
    const hold = connections.pause();
    await expect(connections.connectOwner('runtime-4')).rejects.toThrow('paused');
    const drained = vi.fn();
    const drain = hold.drain().then(drained);
    await Promise.resolve();
    expect(drained).not.toHaveBeenCalled();
    unblock();
    await Promise.all([scan, drain]);
    expect(connected).toHaveBeenCalledTimes(1);
    await connections.close();
    hold.release();
    await expect(connections.connectOwner('runtime-4')).rejects.toThrow('closed');
    expect(release).toHaveBeenCalledOnce();
  } finally {
    unblock();
    await scan;
    await connections.close();
  }
});
