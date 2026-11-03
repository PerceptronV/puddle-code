import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { RuntimeResponse } from '@puddle/shared';
import { RuntimeControls } from '../../src/runtime/controls.js';
import { RuntimeConnectionLost } from '../../src/runtime/client.js';
import type { RuntimeConnections } from '../../src/runtime/connections.js';
import { runtimeDatabase } from '../helpers/runtime-database.js';

function fixture() {
  const f = runtimeDatabase();
  const client = {
    state: { binding: { session_id: f.session.id, segment_id: f.binding.runtime_id } },
    request: vi.fn<(request: { t: string }) => Promise<RuntimeResponse>>(),
  };
  const connections = { get: () => client } as unknown as RuntimeConnections;
  const controls = new RuntimeControls(f.runtimes, connections, f.reconciler);
  return {
    ...f,
    client,
    controls,
    async close() {
      await controls.close();
      await f.reconciler.close();
      f.db.close();
    },
  };
}

it('records stop intent before dispatch and observes a lost acknowledgement without retransmission', async () => {
  const f = fixture();
  try {
    f.client.request.mockImplementation(async () => {
      expect(f.runtimes.stopRequested(f.binding.runtime_id)).toBe(true);
      f.runtimes.finish(f.binding.runtime_id, 'exited', () => {});
      throw new RuntimeConnectionLost();
    });
    await f.controls.stop(f.session.id, () => true);
    expect(f.client.request).toHaveBeenCalledTimes(1);
    expect(f.client.request).toHaveBeenCalledWith(
      expect.objectContaining({
        t: 'stop',
        placement: { session_id: f.session.id, segment_id: f.binding.runtime_id },
      }),
    );
  } finally {
    await f.close();
  }
});

it('does not dispatch queued controls after authority expires or ownership changes', async () => {
  const f = fixture();
  try {
    let inspected!: (response: RuntimeResponse) => void;
    f.client.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          inspected = resolve;
        }),
    );
    let authorised = true;
    const shell = f.controls.spawnShell(
      f.session.id,
      f.launch.main,
      () => false,
      () => authorised,
    );
    const stop = f.controls.stop(f.session.id, () => authorised);
    const completed = Promise.allSettled([shell, stop]);
    await Promise.resolve();
    authorised = false;
    inspected({
      t: 'state',
      id: randomUUID(),
      state: { terminals: [], environment: { enabled: false } },
    } as RuntimeResponse);
    expect((await completed).map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(f.client.request.mock.calls.map(([request]) => request.t)).toEqual(['inspect']);
    expect(f.runtimes.stopRequested(f.binding.runtime_id)).toBe(false);
    f.runtimes.interrupt(f.binding.runtime_id, () => {});
    await expect(f.controls.stop(f.session.id, () => true)).rejects.toThrow(/unavailable/);
    expect(f.client.request).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

it('refuses cleanup after an acknowledged stop whose owner ended without a complete exit record', async () => {
  const f = fixture();
  try {
    f.client.request.mockImplementation(async () => {
      f.runtimes.interrupt(f.binding.runtime_id, () => {});
      return { t: 'ok', id: randomUUID() };
    });
    await expect(f.controls.stop(f.session.id, () => true)).rejects.toMatchObject({
      code: 'runtime_stop_unconfirmed',
    });
    expect(f.runtimes.stopRequested(f.binding.runtime_id)).toBe(true);
  } finally {
    await f.close();
  }
});
