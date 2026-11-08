import { expect, it, vi } from 'vitest';
import { spawnDispatcherFixture } from '../../../helpers/huddle/spawn-dispatch.js';
import { HuddleAgentDispatcher } from '../../../../src/huddle/operations/dispatch/service.js';
import { HuddleAgentSpawns } from '../../../../src/huddle/operations/spawns/service.js';
import { HuddleAgentTurns } from '../../../../src/huddle/operations/turns/service.js';
import { HuddleTurnStore } from '../../../../src/huddle/operations/turns/store.js';
import { RuntimeConnections } from '../../../../src/runtime/transport/connections.js';
import { RuntimeReconciler } from '../../../../src/runtime/controller/reconcile.js';
import { RuntimeControls } from '../../../../src/runtime/controller/controls.js';
import { RuntimeProgrammeTurns } from '../../../../src/runtime/controller/programme-turns.js';
import { ProgrammeTurnStore } from '../../../../src/puddlang/runtime-turn-store.js';

it('adopts pending cleanup with fresh controller connections and confirms Stop without recreating an agent', async () => {
  const f = await spawnDispatcherFixture();
  const cancel = vi.spyOn(f.spawns, 'cancel').mockRejectedValue(new Error('Controller is leaving'));
  let connections: RuntimeConnections | undefined;
  let reconciler: RuntimeReconciler | undefined;
  let controls: RuntimeControls | undefined;
  let dispatcher: HuddleAgentDispatcher | undefined;
  try {
    await f.run();
    await expect.poll(() => f.outcome(), { timeout: 15000 }).toEqual(['completed']);
    const operation = await f.spawnRecord();
    if (!operation?.result || !('agent' in operation.result)) throw new Error('No retained agent');
    const agent = operation.result.agent;
    await f.huddle.request({ t: 'interrupt' });
    await expect
      .poll(async () => (await f.spawnRecord())?.cleanup)
      .toEqual({ state: 'pending', error: 'Controller is leaving' });
    await f.dispatcher.close();
    await f.connections.close();
    await f.reconciler.close();
    expect(f.runtimes.get(agent.runtimeId)?.state).toBe('running');
    expect(f.owner.child.exitCode).toBeNull();
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
    await controls.huddles.stop(operation.scope.owner.session_id, () => true);
    expect(f.runtimes.get(agent.runtimeId)?.state).toBe('exited');
    expect(f.runtimes.get(operation.scope.owner.runtime_id)?.state).toBe('exited');
    expect(f.supervisorRun).toHaveBeenCalledOnce();
    expect(
      f.db.prepare('SELECT stop_requested, stop_attempted FROM huddle_runtime_spawns').get(),
    ).toEqual({ stop_requested: 1, stop_attempted: 1 });
  } finally {
    cancel.mockRestore();
    await dispatcher?.close();
    await controls?.close();
    await connections?.close();
    await reconciler?.close();
    await f.close();
  }
});
