import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { agentOwnerFixture } from '../../helpers/huddle/agent-owner.js';
import { HuddleAgentDispatcher } from '../../../src/huddle/operations/dispatch/service.js';
import { resolveHuddleAgent } from '../../../src/huddle/execution/agents.js';
import { readRuntimeJson } from '../../../src/runtime/ownership/storage.js';
import {
  RuntimeConnectionLost,
  RuntimeRequestRejected,
} from '../../../src/runtime/transport/client.js';
import { RuntimeConnections } from '../../../src/runtime/transport/connections.js';
import { RuntimeReconciler } from '../../../src/runtime/controller/reconcile.js';
import { RuntimeProgrammeTurns } from '../../../src/runtime/controller/programme-turns.js';
import { ProgrammeTurnStore } from '../../../src/puddlang/runtime-turn-store.js';
import { HuddleAgentTurns } from '../../../src/huddle/operations/turns/service.js';
import { HuddleTurnStore } from '../../../src/huddle/operations/turns/store.js';

async function fixture() {
  const f = await agentOwnerFixture();
  let dispatcher = new HuddleAgentDispatcher(f);
  dispatcher.start();
  return {
    ...f,
    get dispatcher() {
      return dispatcher;
    },
    replace() {
      dispatcher = new HuddleAgentDispatcher(f);
      dispatcher.start();
    },
    async close() {
      await dispatcher.close();
      await f.close();
    },
    async outcome() {
      const page = await f.huddle.request({ t: 'records', collection: 'executions', after: 0 });
      if (page.t !== 'records') throw new Error('No executions');
      return page.rows.map((row) => JSON.parse(row.body).state);
    },
  };
}

it('automatically dispatches a captured script ask and acknowledges only its saved outcome', async () => {
  const f = await fixture();
  try {
    const requests = vi.spyOn(f.client, 'request');
    const operation = await f.run('automatic review');
    await expect.poll(() => f.outcome(), { timeout: 10000 }).toEqual(['completed']);
    await expect
      .poll(() => f.db.prepare('SELECT consumed FROM runtime_turns').get())
      .toEqual({ consumed: 1 });
    expect(readRuntimeJson(join(f.home, `${f.session.id}.turns.json`))).toMatchObject({ count: 1 });
    expect(requests.mock.calls.find(([request]) => request.t === 'start-turn')?.[0]).toMatchObject({
      origin: {
        huddleId: f.huddle.state!.scope.huddleId,
        executionId: operation.scope.executionId,
        operationId: operation.scope.operationId,
      },
    });
    expect(
      resolveHuddleAgent(
        { sessions: f.sessions, runtimes: f.runtimes, turns: f.programmeTurns },
        f.profile.id,
        f.project.id,
        f.session.id,
        f.launch.identity.canonical_worktree_path,
      ),
    ).toContain(f.binding.runtime_id);
    expect(() =>
      resolveHuddleAgent(
        { sessions: f.sessions, runtimes: f.runtimes, turns: f.programmeTurns },
        f.profile.id,
        f.project.id,
        f.session.id,
        '/unrelated',
      ),
    ).toThrow();
  } finally {
    await f.close();
  }
});

it('observes a lost settlement reply before acknowledging without blindly repeating it', async () => {
  const f = await fixture();
  try {
    const original = f.huddle.request.bind(f.huddle);
    let settlements = 0;
    vi.spyOn(f.huddle, 'request').mockImplementation(async (value) => {
      const response = await original(value);
      if (value.t === 'operation-settle') {
        settlements++;
        throw new RuntimeConnectionLost();
      }
      return response;
    });
    await f.run('retain lost result acknowledgement');
    await expect.poll(() => f.outcome(), { timeout: 10000 }).toEqual(['completed']);
    await expect
      .poll(() => f.db.prepare('SELECT consumed FROM runtime_turns').get())
      .toEqual({ consumed: 1 });
    expect(settlements).toBe(1);
  } finally {
    await f.close();
  }
});

it('surfaces a correlated busy refusal as a failed node without dispatching a prompt', async () => {
  const f = await fixture();
  try {
    const original = f.client.request.bind(f.client);
    vi.spyOn(f.client, 'request').mockImplementation((value) =>
      value.t === 'start-turn'
        ? Promise.reject(new RuntimeRequestRejected('busy', 'fixture busy', 'start-turn'))
        : original(value),
    );
    await f.run('busy review');
    await expect.poll(() => f.outcome(), { timeout: 10000 }).toEqual(['failed']);
    const page = await f.huddle.request({ t: 'operation-page', after: 0 });
    expect(page).toMatchObject({
      page: {
        records: [{ operation: { state: 'failed', result: { rejected: expect.any(String) } } }],
      },
    });
    expect(f.db.prepare('SELECT * FROM runtime_result_charges').all()).toEqual([]);
  } finally {
    await f.close();
  }
});

it('preserves an admitted agent turn through dispatcher shutdown and adopts its reply without replay', async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.home, 'test-slow-turn'), '');
    await f.run('survive dispatch handoff');
    await expect
      .poll(() => f.reconciler.observations.turn(f.binding.runtime_id, 1)?.status)
      .toBe('running');
    await f.dispatcher.close();
    expect(f.db.prepare('SELECT cancellation_attempted FROM huddle_runtime_turns').get()).toEqual({
      cancellation_attempted: 0,
    });
    f.replace();
    await expect.poll(() => f.outcome(), { timeout: 10000 }).toEqual(['completed']);
    expect(readRuntimeJson(join(f.home, `${f.session.id}.turns.json`))).toMatchObject({ count: 1 });
  } finally {
    await f.close();
  }
});

it('pauses new claims during maintenance and cancels an interrupted admitted turn once', async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.home, 'test-slow-turn'), '');
    const hold = f.dispatcher.pause();
    await hold.drain();
    const operation = await f.run('interrupt review');
    expect(operation.state).toBe('prepared');
    expect(f.db.prepare('SELECT * FROM huddle_runtime_turns').all()).toEqual([]);
    hold.release();
    await expect
      .poll(() => f.reconciler.observations.turn(f.binding.runtime_id, 1)?.status)
      .toBe('running');
    await f.huddle.request({ t: 'interrupt' });
    await expect
      .poll(() => f.reconciler.observations.turn(f.binding.runtime_id, 1)?.status)
      .toBe('cancelled');
    expect(f.db.prepare('SELECT cancellation_attempted FROM huddle_runtime_turns').get()).toEqual({
      cancellation_attempted: 1,
    });
    await f.dispatcher.close();
    f.replace();
    await expect.poll(() => f.outcome()).toEqual(['interrupted']);
    expect(readRuntimeJson(join(f.home, `${f.session.id}.turns.json`))).toMatchObject({ count: 1 });
  } finally {
    await f.close();
  }
});

it('replaces both controller connections and reconciliation while owners finish one accepted ask', async () => {
  const f = await fixture();
  let connections: RuntimeConnections | undefined;
  let reconciler: RuntimeReconciler | undefined;
  let dispatcher: HuddleAgentDispatcher | undefined;
  try {
    writeFileSync(join(f.home, 'test-slow-turn'), '');
    await f.run('survive controller replacement');
    await expect
      .poll(() => f.reconciler.observations.turn(f.binding.runtime_id, 1)?.status)
      .toBe('running');
    await f.dispatcher.close();
    await f.reconciler.close();
    await f.connections.close();
    reconciler = new RuntimeReconciler(f);
    connections = new RuntimeConnections(f.home, f.runtimes, {
      connected: (id, client) => reconciler!.attach(id, client),
      huddleConnected: (id, client) => reconciler!.attachHuddle(id, client),
    });
    await connections.connect();
    const turns = new HuddleAgentTurns(
      new RuntimeProgrammeTurns(f.runtimes, connections, reconciler, new ProgrammeTurnStore(f.db)),
      new HuddleTurnStore(f.db),
    );
    dispatcher = new HuddleAgentDispatcher({ ...f, connections, reconciler, turns });
    dispatcher.start();
    await expect
      .poll(
        async () => {
          const page = await connections!
            .getHuddle(f.launch.identity.runtime_id)!
            .request({ t: 'records', collection: 'executions', after: 0 });
          return (
            page.t === 'records' &&
            page.rows.some((row) => JSON.parse(row.body).state === 'completed')
          );
        },
        { timeout: 10000 },
      )
      .toBe(true);
    await expect
      .poll(() => f.db.prepare('SELECT consumed FROM runtime_turns').get())
      .toEqual({ consumed: 1 });
    expect(readRuntimeJson(join(f.home, `${f.session.id}.turns.json`))).toMatchObject({ count: 1 });
  } finally {
    await dispatcher?.close();
    await reconciler?.close();
    await connections?.close();
    await f.close();
  }
});
