import { expect, it, vi } from 'vitest';
import { RuntimeConnections } from '../../../src/runtime/transport/connections.js';
import type { RuntimeClient } from '../../../src/runtime/transport/client.js';
import { acquireRuntimeControllerWhenAvailable } from '../../../src/runtime/ownership/storage.js';
import { runtimeDatabase } from '../../helpers/runtime-database.js';
import {
  launchOwner,
  terminal,
  waitForOwner,
  waitForSnapshot,
} from '../../helpers/runtime-fixture.js';
import { placement } from '../../helpers/runtime-placement.js';

it('drains an admitted attachment, retains its live owner and resumes discovery after a disconnect', async () => {
  const f = runtimeDatabase();
  let connections: RuntimeConnections | undefined;
  let hold: ReturnType<RuntimeConnections['pause']> | undefined;
  let release!: () => void;
  const admitted = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const owner = launchOwner(f.home, f.binding.runtime_id);
    await waitForOwner(owner, f.directory);
    f.controller.release();
    const connected = vi.fn(async (id: string, client: RuntimeClient) => {
      await admitted;
      await f.reconciler.attach(id, client);
    });
    connections = new RuntimeConnections(
      f.home,
      f.runtimes,
      {
        connected,
        missing: (id) => f.reconciler.retire(id),
      },
      await acquireRuntimeControllerWhenAvailable(f.home),
    );
    const installed = vi.fn();
    connections.on('connected', installed);
    const connecting = connections.connect();
    await vi.waitFor(() => expect(connected).toHaveBeenCalledOnce());
    hold = connections.pause();
    const drained = vi.fn();
    const drain = hold.drain().then(drained);
    await Promise.resolve();
    expect(drained).not.toHaveBeenCalled();
    release();
    await Promise.all([connecting, drain]);
    expect(installed).toHaveBeenCalledOnce();
    const first = connections.get(f.binding.runtime_id)!;
    const main = terminal(first.state);
    await expect(connections.connect()).rejects.toThrow(/paused/);
    await first.request({
      t: 'input',
      placement: placement(first),
      term: 'agent',
      generation: main.generation,
      source: 'human',
      data: 'stty -echo; counter=1; counter=$((counter+1)); printf \'paused-owner-%s\\n\' "$counter"\n',
    });
    await waitForSnapshot(first, main.generation, 'paused-owner-2');
    first.close();
    expect(connections.get(f.binding.runtime_id)).toBeNull();
    expect(connections.unavailableIds()).toContain(f.binding.runtime_id);
    expect(f.runtimes.get(f.binding.runtime_id)?.state).toBe('running');
    hold.release();
    await vi.waitFor(() => expect(installed).toHaveBeenCalledTimes(2));
    const next = connections.get(f.binding.runtime_id)!;
    expect(next).not.toBe(first);
    expect(terminal(next.state).pid).toBe(main.pid);
    await next.request({
      t: 'input',
      placement: placement(next),
      term: 'agent',
      generation: main.generation,
      source: 'human',
      data: 'printf \'resumed-owner-%s\\n\' "$counter"\n',
    });
    await waitForSnapshot(next, main.generation, 'resumed-owner-2');
    hold = connections.pause();
    await hold.drain();
    await connections.close();
    hold.release();
    await expect(connections.connect()).rejects.toThrow(/closed/);
    expect(() => connections!.pause()).toThrow(/maintenance/);
  } finally {
    release();
    await f.reconciler.close();
    await connections?.close();
    hold?.release();
    f.db.close();
  }
});
