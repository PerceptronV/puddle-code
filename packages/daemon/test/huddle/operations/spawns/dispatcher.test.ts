import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { spawnOwnerFixture } from '../../../helpers/huddle/spawn-owner.js';
import { HuddleAgentDispatcher } from '../../../../src/huddle/operations/dispatch/service.js';
import { HuddleAgentSpawns } from '../../../../src/huddle/operations/spawns/service.js';
import { HuddleAgentTurns } from '../../../../src/huddle/operations/turns/service.js';
import { HuddleTurnStore } from '../../../../src/huddle/operations/turns/store.js';
import { AccountStore } from '../../../../src/db/stores/accounts.js';
import { RuntimeConnectionLost } from '../../../../src/runtime/transport/client.js';
import { readRuntimeJson } from '../../../../src/runtime/ownership/storage.js';
import { RuntimeConnections } from '../../../../src/runtime/transport/connections.js';
import { RuntimeReconciler } from '../../../../src/runtime/controller/reconcile.js';
import { RuntimeProgrammeTurns } from '../../../../src/runtime/controller/programme-turns.js';
import { RuntimeControls } from '../../../../src/runtime/controller/controls.js';
import { ProgrammeTurnStore } from '../../../../src/puddlang/runtime-turn-store.js';

async function fixture() {
  const f = await spawnOwnerFixture();
  const turns = new HuddleAgentTurns(f.deps.turns, new HuddleTurnStore(f.db));
  let dispatcher = new HuddleAgentDispatcher({ ...f, turns });
  dispatcher.start();
  return {
    ...f,
    get dispatcher() {
      return dispatcher;
    },
    replace(spawns = f.spawns) {
      dispatcher = new HuddleAgentDispatcher({ ...f, turns, spawns });
      dispatcher.start();
    },
    async outcome() {
      const reply = await f.huddle.request({ t: 'records', collection: 'executions', after: 0 });
      if (reply.t !== 'records') throw new Error('No execution records');
      return reply.rows.map((row) => JSON.parse(row.body).state);
    },
    async spawnRecord() {
      const reply = await f.huddle.request({ t: 'spawn-page', after: 0 });
      if (reply.t !== 'spawn-page') throw new Error('No spawn records');
      return reply.page.records[0]?.operation;
    },
    async close() {
      await dispatcher.close();
      for (const row of f.db.prepare('SELECT intent FROM huddle_runtime_spawns').all() as {
        intent: string;
      }[]) {
        const { scope, request } = JSON.parse(row.intent);
        try {
          await f.spawns.cancel(scope, request, () => true);
        } catch {
          /* Isolated fixture child tracking fences unresolved processes. */
        }
      }
      await f.close();
    },
  };
}

it('automatically creates one agent, returns its handle and completes the next exact prompt', async () => {
  const f = await fixture();
  try {
    await f.run();
    await expect.poll(() => f.outcome(), { timeout: 15000 }).toEqual(['completed']);
    const operation = await f.spawnRecord();
    expect(operation).toMatchObject({ state: 'completed' });
    if (!operation?.result || !('agent' in operation.result)) throw new Error('No spawn outcome');
    const agent = operation.result.agent;
    expect(f.supervisorRun).toHaveBeenCalledOnce();
    expect(readRuntimeJson(join(f.home, `${agent.sessionId}.turns.json`))).toMatchObject({
      count: 1,
    });
    await expect
      .poll(() => f.db.prepare('SELECT consumed FROM runtime_turns').get())
      .toEqual({ consumed: 1 });
    expect(f.runtimes.get(agent.runtimeId)?.state).toBe('running');
  } finally {
    await f.close();
  }
});

it('observes an accepted spawn after dispatcher replacement without creating or stopping another agent', async () => {
  const f = await fixture();
  const observe = vi.spyOn(f.spawns, 'observe').mockReturnValue(null);
  try {
    await f.run();
    let runtimeId: string | undefined;
    await expect
      .poll(
        () => {
          runtimeId = (
            f.db.prepare('SELECT runtime_id FROM huddle_runtime_spawns').get() as
              { runtime_id?: string } | undefined
          )?.runtime_id;
          return runtimeId && f.runtimes.get(runtimeId)?.state;
        },
        { timeout: 15000 },
      )
      .toBe('running');
    await f.dispatcher.close();
    expect(
      f.db.prepare('SELECT stop_requested, stop_attempted FROM huddle_runtime_spawns').get(),
    ).toEqual({ stop_requested: 0, stop_attempted: 0 });
    expect(f.runtimes.get(runtimeId!)?.state).toBe('running');
    observe.mockRestore();
    f.replace(new HuddleAgentSpawns(f.deps));
    await expect.poll(() => f.outcome(), { timeout: 15000 }).toEqual(['completed']);
    expect(f.supervisorRun).toHaveBeenCalledOnce();
  } finally {
    observe.mockRestore();
    await f.close();
  }
});

it('never dispatches creation after losing a consumed owner claim reply', async () => {
  const f = await fixture();
  const original = f.huddle.request.bind(f.huddle);
  let claims = 0;
  vi.spyOn(f.huddle, 'request').mockImplementation(async (value) => {
    const reply = await original(value);
    if (value.t === 'spawn-claim') {
      claims++;
      throw new RuntimeConnectionLost();
    }
    return reply;
  });
  try {
    await f.run();
    await expect.poll(async () => (await f.spawnRecord())?.state).toBe('dispatched');
    await f.dispatcher.close();
    await f.huddle.request({ t: 'interrupt' });
    f.replace();
    await expect.poll(async () => (await f.spawnRecord())?.state).toBe('unknown');
    expect(claims).toBe(1);
    expect(f.supervisorRun).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT count(*) AS n FROM huddle_runtime_spawns').get()).toEqual({ n: 0 });
  } finally {
    await f.close();
  }
});

it('reads the owner outcome after losing a settlement reply rather than sending another spawn or settlement', async () => {
  const f = await fixture();
  const original = f.huddle.request.bind(f.huddle);
  let settlements = 0;
  vi.spyOn(f.huddle, 'request').mockImplementation(async (value) => {
    const reply = await original(value);
    if (value.t === 'spawn-settle') {
      settlements++;
      throw new RuntimeConnectionLost();
    }
    return reply;
  });
  try {
    await f.run();
    await expect.poll(() => f.outcome(), { timeout: 15000 }).toEqual(['completed']);
    expect(settlements).toBe(1);
    expect(f.supervisorRun).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it('keeps claims paused during maintenance and resumes both spawn and ask queues on release', async () => {
  const f = await fixture();
  const hold = f.dispatcher.pause();
  try {
    await hold.drain();
    expect((await f.run()).state).toBe('prepared');
    expect(f.supervisorRun).not.toHaveBeenCalled();
    hold.release();
    await expect.poll(() => f.outcome(), { timeout: 15000 }).toEqual(['completed']);
    expect(f.supervisorRun).toHaveBeenCalledOnce();
  } finally {
    hold.release();
    await f.close();
  }
});

it('reports a definite admission refusal as a failed node without creating an agent', async () => {
  const f = await fixture();
  try {
    new AccountStore(f.db).setLoggedIn(f.account!.id, false);
    await f.run();
    await expect.poll(() => f.outcome(), { timeout: 10000 }).toEqual(['failed']);
    expect(await f.spawnRecord()).toMatchObject({
      state: 'failed',
      result: { rejected: expect.stringContaining('account/project') },
    });
    expect(f.supervisorRun).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT count(*) AS n FROM huddle_runtime_spawns').get()).toEqual({ n: 0 });
  } finally {
    await f.close();
  }
});

it('adopts spawn readiness with new controller connections and reconciliation without replay', async () => {
  const f = await fixture();
  const observe = vi.spyOn(f.spawns, 'observe').mockReturnValue(null);
  let connections: RuntimeConnections | undefined;
  let reconciler: RuntimeReconciler | undefined;
  let controls: RuntimeControls | undefined;
  let dispatcher: HuddleAgentDispatcher | undefined;
  try {
    const operation = await f.run();
    await expect
      .poll(
        () => {
          const row = f.db.prepare('SELECT runtime_id FROM huddle_runtime_spawns').get() as
            { runtime_id: string } | undefined;
          return row?.runtime_id && f.runtimes.get(row.runtime_id)?.state;
        },
        { timeout: 15000 },
      )
      .toBe('running');
    await f.dispatcher.close();
    await f.reconciler.close();
    await f.connections.close();
    observe.mockRestore();
    reconciler = new RuntimeReconciler(f);
    connections = new RuntimeConnections(f.home, f.runtimes, {
      connected: (id, client) => reconciler!.attach(id, client),
      missing: (id) => reconciler!.retire(id),
      huddleConnected: (id, client) => reconciler!.attachHuddle(id, client),
      huddleMissing: (id) => reconciler!.retire(id),
    });
    await connections.connect();
    controls = new RuntimeControls(f.runtimes, connections, reconciler);
    const nativeTurns = new RuntimeProgrammeTurns(
      f.runtimes,
      connections,
      reconciler,
      new ProgrammeTurnStore(f.db),
    );
    const spawns = new HuddleAgentSpawns({ ...f.deps, connections, controls, turns: nativeTurns });
    const turns = new HuddleAgentTurns(nativeTurns, new HuddleTurnStore(f.db));
    dispatcher = new HuddleAgentDispatcher({ ...f, connections, reconciler, spawns, turns });
    dispatcher.start();
    const client = connections.getHuddle(operation.scope.owner.runtime_id)!;
    await expect
      .poll(
        async () => {
          const reply = await client.request({ t: 'records', collection: 'executions', after: 0 });
          return reply.t === 'records' && reply.rows.map((row) => JSON.parse(row.body).state);
        },
        { timeout: 15000 },
      )
      .toEqual(['completed']);
    expect(f.supervisorRun).toHaveBeenCalledOnce();
    expect(await spawns.cancel(operation.scope, operation.request, () => true)).toEqual({
      state: 'stopped',
    });
    await client.request({ t: 'interrupt' });
    await client.request({ t: 'shutdown' });
  } finally {
    observe.mockRestore();
    await dispatcher?.close();
    await controls?.close();
    await connections?.close();
    await reconciler?.close();
    await f.close();
  }
});
