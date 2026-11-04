import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { RuntimeResponse, RuntimeState } from '@puddle/shared';
import { RuntimeControls } from '../../../src/runtime/controller/controls.js';
import { RuntimeConnectionLost } from '../../../src/runtime/transport/client.js';
import type { RuntimeConnections } from '../../../src/runtime/transport/connections.js';
import { runtimeDatabase } from '../../helpers/runtime-database.js';

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

it('checks reviewed state under the shell-control queue before recording stop intent', async () => {
  const f = fixture();
  f.runtimes.observe(
    f.binding.runtime_id,
    {
      cursor: 0,
      sessionId: f.session.id,
      conversationId: null,
      state: 'running',
      segment: { id: f.binding.runtime_id, start_cursor: 0, agent_session_ref: null },
    },
    () => {},
  );
  // Only fields consumed by inspection; the transport decoder validates complete owner replies.
  const state = {
    journal: { cursor: 0 },
    binding: { session_id: f.session.id, segment_id: f.binding.runtime_id },
    history: { current: { id: f.binding.runtime_id } },
  } as RuntimeState;
  try {
    f.client.request.mockResolvedValue({ t: 'state', id: randomUUID(), state });
    await expect(
      f.controls.stop(
        f.session.id,
        () => true,
        () => {
          throw new Error('Review changed');
        },
      ),
    ).rejects.toThrow('Review changed');
    expect(f.client.request.mock.calls.map(([request]) => request.t)).toEqual(['inspect']);
    expect(f.runtimes.stopRequested(f.binding.runtime_id)).toBe(false);
    f.client.request.mockImplementation(async () => {
      state.history.current.id = randomUUID();
      return { t: 'state', id: randomUUID(), state };
    });
    const review = vi.fn();
    await expect(f.controls.stop(f.session.id, () => true, review)).rejects.toMatchObject({
      code: 'runtime_reconciliation_required',
    });
    expect(review).not.toHaveBeenCalled();
    expect(f.runtimes.stopRequested(f.binding.runtime_id)).toBe(false);
  } finally {
    await f.close();
  }
});

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
    // This transport double supplies only the state fields consumed before authority rejection.
    inspected({
      t: 'state',
      id: randomUUID(),
      state: { terminals: [], environment: { enabled: false } },
    } as unknown as RuntimeResponse);
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

it('drains accepted controls during maintenance, rejects new controls and does not replay them on release', async () => {
  const f = fixture();
  let respond!: (value: RuntimeResponse) => void;
  f.client.request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        respond = resolve;
      }),
  );
  f.runtimes.observe(
    f.binding.runtime_id,
    {
      cursor: 0,
      sessionId: f.session.id,
      conversationId: null,
      state: 'running',
      segment: { id: f.binding.runtime_id, start_cursor: 0, agent_session_ref: null },
    },
    () => {},
  );
  const accepted = f.controls.clearEnvironment(f.session.id, () => true);
  try {
    await vi.waitFor(() => expect(respond).toBeDefined());
    const hold = f.controls.pause();
    const drained = vi.fn();
    const drain = hold.drain().then(drained);
    await expect(f.controls.clearEnvironment(f.session.id, () => true)).rejects.toMatchObject({
      code: 'host_maintenance',
    });
    expect(drained).not.toHaveBeenCalled();
    respond({ t: 'env-cleared', id: randomUUID(), cleared: 2, through: 0 });
    expect(await accepted).toBe(2);
    await drain;
    expect(f.client.request).toHaveBeenCalledOnce();
    hold.release();
    expect(f.client.request).toHaveBeenCalledOnce();
    f.client.request.mockResolvedValue({
      t: 'env-cleared',
      id: randomUUID(),
      cleared: 0,
      through: 0,
    });
    expect(await f.controls.clearEnvironment(f.session.id, () => true)).toBe(0);
    const shutdown = f.controls.pause();
    await f.controls.close();
    shutdown.release();
    await expect(f.controls.clearEnvironment(f.session.id, () => true)).rejects.toMatchObject({
      code: 'host_maintenance',
    });
  } finally {
    await f.close();
  }
});
