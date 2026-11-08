import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { HuddleAgentTurns } from '../../../src/huddle/operations/turns/service.js';
import { HuddleTurnStore } from '../../../src/huddle/operations/turns/store.js';
import {
  RuntimeConnectionLost,
  RuntimeRequestRejected,
} from '../../../src/runtime/transport/client.js';
import { readRuntimeJson } from '../../../src/runtime/ownership/storage.js';
import { RuntimeReconciler } from '../../../src/runtime/controller/reconcile.js';
import { RuntimeConnections } from '../../../src/runtime/transport/connections.js';
import { programmeOwnerFixture } from '../../helpers/runtime/programme-owner.js';
import { huddleTurnScope } from '../../helpers/huddle/agent-turns.js';

async function fixture() {
  const f = await programmeOwnerFixture();
  const scope = huddleTurnScope(f);
  const store = new HuddleTurnStore(f.db);
  const service = new HuddleAgentTurns(f.turns, store);
  return { ...f, huddle: scope, store, service };
}

it('adopts an accepted huddle turn after controller replacement without replaying its prompt', async () => {
  const f = await fixture();
  let replacement: RuntimeConnections | undefined;
  let reconciler: RuntimeReconciler | undefined;
  try {
    writeFileSync(join(f.home, 'test-slow-turn'), '');
    const controller = new AbortController();
    const input = { prompt: 'continue through replacement' };
    const sent = vi.fn(() => controller.abort(new Error('Controller replaced')));
    await expect(
      f.service.ask(
        f.huddle,
        input,
        controller.signal,
        () => true,
        () => true,
        sent,
      ),
    ).rejects.toThrow('Controller replaced');
    expect(sent).toHaveBeenCalledTimes(1);
    await f.reconciler.close();
    await f.connections.close();
    reconciler = new RuntimeReconciler(f);
    replacement = new RuntimeConnections(f.home, f.runtimes, {
      connected: (id, client) => reconciler!.attach(id, client),
    });
    // The synthetic source huddle has no transport; adopt only the real agent owner.
    await replacement.connectOwner(f.binding.runtime_id);
    const observe = () => new HuddleTurnStore(f.db).bind(f.huddle, input, () => true).observe();
    await expect.poll(() => observe().result?.status, { timeout: 10_000 }).toBe('completed');
    expect(observe()).toMatchObject({
      acknowledged: false,
      result: { reply: 'reply:1:continue through replacement' },
    });
    expect(readRuntimeJson(join(f.home, `${f.session.id}.turns.json`))).toMatchObject({ count: 1 });
    expect(f.db.prepare('SELECT consumed FROM runtime_turns').get()).toEqual({ consumed: 0 });
  } finally {
    await reconciler?.close();
    await replacement?.close();
    await f.close();
  }
});

it('dispatches one huddle prompt through the existing owner, observes a lost reply, and retains the result until owner acknowledgement', async () => {
  const f = await fixture();
  try {
    const request = f.client.request.bind(f.client);
    let sent = 0;
    vi.spyOn(f.client, 'request').mockImplementation(async (value) => {
      if (value.t !== 'start-turn') return request(value);
      sent++;
      expect(f.db.prepare('SELECT runtime_id, turn FROM huddle_runtime_turns').get()).toEqual({
        runtime_id: f.binding.runtime_id,
        turn: value.turn,
      });
      await request(value);
      f.client.close();
      throw new RuntimeConnectionLost();
    });
    const input = { prompt: 'once from huddle' };
    await expect(
      f.service.ask(f.huddle, input, new AbortController().signal, () => true),
    ).resolves.toBe('reply:1:once from huddle');
    expect(sent).toBe(1);
    expect(f.db.prepare('SELECT consumed FROM runtime_turns').get()).toEqual({ consumed: 0 });
    // A replacement host adapter reads retained identity; it never reissues an ask.
    const replacement = new HuddleAgentTurns(f.turns, new HuddleTurnStore(f.db));
    const outcome = replacement.observe(f.huddle, input, () => true);
    expect(outcome.result).toMatchObject({
      status: 'completed',
      reply: 'reply:1:once from huddle',
    });
    replacement.acknowledge(f.huddle, input, outcome.receipt!, () => true);
    expect(f.db.prepare('SELECT consumed FROM runtime_turns').get()).toEqual({ consumed: 1 });
    await expect(
      replacement.ask(f.huddle, input, new AbortController().signal, () => true),
    ).rejects.toMatchObject({ code: 'operation_already_dispatched' });
    expect(readRuntimeJson(join(f.home, `${f.session.id}.turns.json`))).toMatchObject({ count: 1 });
  } finally {
    await f.close();
  }
});

it('shares busy admission between huddle and programme callers without interrupting the active ask', async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.home, 'test-slow-turn'), '');
    const dispatched = vi.fn();
    const answer = f.service.ask(
      f.huddle,
      { prompt: 'huddle first' },
      new AbortController().signal,
      () => true,
      undefined,
      dispatched,
    );
    await expect.poll(() => dispatched.mock.calls.length).toBe(1);
    await expect(
      f.turns.ask(
        f.binding.runtime_id,
        f.scope,
        'competing programme',
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'runtime_busy' });
    await expect(answer).resolves.toBe('reply:1:huddle first');
    expect(f.db.prepare('SELECT * FROM puddlang_runtime_turns').all()).toEqual([]);
  } finally {
    await f.close();
  }
});

it('rechecks owner authority after inspection and before recording or dispatching a prompt', async () => {
  const f = await fixture();
  try {
    let allowed = true;
    const request = f.client.request.bind(f.client);
    vi.spyOn(f.client, 'request').mockImplementation(async (value) => {
      const response = await request(value);
      if (value.t === 'inspect') allowed = false;
      return response;
    });
    await expect(
      f.service.ask(f.huddle, { prompt: 'revoked' }, new AbortController().signal, () => allowed),
    ).rejects.toThrow('authority expired');
    expect(f.db.prepare('SELECT * FROM huddle_runtime_turns').all()).toEqual([]);
    expect(f.db.prepare('SELECT turns FROM host_result_usage').get()).toEqual({ turns: 0 });
    expect(existsSync(join(f.home, `${f.session.id}.turns.json`))).toBe(false);
  } finally {
    await f.close();
  }
});

it('releases a correlated pre-admission rejection but never permits the operation to send again', async () => {
  const f = await fixture();
  try {
    const request = f.client.request.bind(f.client);
    vi.spyOn(f.client, 'request').mockImplementation((value) =>
      request(
        value.t === 'start-turn' ? { ...value, expected_ref: 'different-before-admission' } : value,
      ),
    );
    await expect(
      f.service.ask(f.huddle, { prompt: 'refuse' }, new AbortController().signal, () => true),
    ).rejects.toBeInstanceOf(RuntimeRequestRejected);
    expect(f.db.prepare('SELECT turns FROM host_result_usage').get()).toEqual({ turns: 0 });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM huddle_runtime_turns').get()).toEqual({ n: 1 });
    await expect(
      f.service.ask(f.huddle, { prompt: 'refuse' }, new AbortController().signal, () => true),
    ).rejects.toMatchObject({ code: 'operation_already_dispatched' });
    expect(existsSync(join(f.home, `${f.session.id}.turns.json`))).toBe(false);
  } finally {
    await f.close();
  }
});

it('cancels only the admitted turn after huddle Stop while retaining its outcome for observation', async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.home, 'test-slow-turn'), '');
    const request = f.client.request.bind(f.client);
    const cancel = vi.fn();
    vi.spyOn(f.client, 'request').mockImplementation((value) => {
      if (value.t === 'cancel-turn') cancel(value);
      return request(value);
    });
    const controller = new AbortController();
    await expect(
      f.service.ask(
        f.huddle,
        { prompt: 'interrupt this turn' },
        controller.signal,
        () => true,
        undefined,
        () => {
          f.db
            .prepare('INSERT INTO huddle_stop_requests VALUES (?, ?, ?)')
            .run(f.huddle.owner.runtime_id, f.huddle.owner.session_id, new Date().toISOString());
          controller.abort(new Error('Huddle stopped'));
        },
      ),
    ).rejects.toThrow('Huddle stopped');
    expect(cancel).toHaveBeenCalledExactlyOnceWith({
      t: 'cancel-turn',
      turn: 1,
      placement: { session_id: f.session.id, segment_id: f.binding.active_segment_id },
    });
    await expect
      .poll(
        () =>
          f.service.observe(f.huddle, { prompt: 'interrupt this turn' }, () => true).result?.status,
      )
      .toBe('cancelled');
    await expect(
      f.service.ask(
        { ...f.huddle, operationId: randomUUID() },
        { prompt: 'no new work' },
        new AbortController().signal,
        () => true,
      ),
    ).rejects.toThrow('no longer available');
  } finally {
    await f.close();
  }
});
