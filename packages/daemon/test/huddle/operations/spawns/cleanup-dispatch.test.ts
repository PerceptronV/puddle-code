import { expect, it, vi } from 'vitest';
import { spawnDispatcherFixture as fixture } from '../../../helpers/huddle/spawn-dispatch.js';
import { HuddleAgentSpawns } from '../../../../src/huddle/operations/spawns/service.js';
import { RuntimeConnectionLost } from '../../../../src/runtime/transport/client.js';

async function completed(f: Awaited<ReturnType<typeof fixture>>) {
  await f.run();
  await expect.poll(() => f.outcome(), { timeout: 15000 }).toEqual(['completed']);
  const operation = await f.spawnRecord();
  if (!operation?.result || !('agent' in operation.result)) throw new Error('No retained agent');
  return operation.result.agent;
}

it('retains successful agents until explicit Interrupt and confirms one exact stop', async () => {
  const f = await fixture();
  try {
    const agent = await completed(f);
    expect(f.runtimes.get(agent.runtimeId)?.state).toBe('running');
    expect((await f.spawnRecord())?.cleanup).toEqual({ state: 'retained' });
    await f.huddle.request({ t: 'interrupt' });
    await expect
      .poll(async () => (await f.spawnRecord())?.cleanup, { timeout: 15000 })
      .toEqual({ state: 'confirmed', outcome: 'stopped' });
    expect(f.runtimes.get(agent.runtimeId)?.state).toBe('exited');
    expect(
      f.db.prepare('SELECT stop_requested, stop_attempted FROM huddle_runtime_spawns').get(),
    ).toEqual({ stop_requested: 1, stop_attempted: 1 });
    const state = await f.huddle.request({ t: 'inspect' });
    expect(state).toMatchObject({
      t: 'state',
      state: { state: 'running', failure: null, control: { state: 'interrupted' } },
    });
    expect(f.supervisorRun).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it('finishes host Stop only after retained agents have positively exited', async () => {
  const f = await fixture();
  try {
    const agent = await completed(f);
    await f.controls.huddles.stop(f.scope.owner.session_id, () => true);
    expect(f.runtimes.get(agent.runtimeId)?.state).toBe('exited');
    expect(f.runtimes.get(f.scope.owner.runtime_id)?.state).toBe('exited');
    expect(f.supervisorRun).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it('cleans an owned agent when its execution deadline expires without interrupting the huddle', async () => {
  const f = await fixture((snapshot) => {
    snapshot.definition.execution.timeoutMs = 6000;
    snapshot.files['nodes/example/run.ts'] = snapshot.files['nodes/example/run.ts']!.replace(
      "return {completed: await agent.ask('Review the graph')};",
      'await new Promise(() => {}); return {completed: null};',
    );
  });
  try {
    await f.run();
    await expect
      .poll(async () => (await f.spawnRecord())?.state, { timeout: 15000 })
      .toBe('completed');
    const operation = await f.spawnRecord();
    if (!operation?.result || !('agent' in operation.result)) throw new Error('No retained agent');
    await expect.poll(() => f.outcome(), { timeout: 15000 }).toEqual(['failed']);
    await expect
      .poll(async () => (await f.spawnRecord())?.cleanup, { timeout: 15000 })
      .toEqual({ state: 'confirmed', outcome: 'stopped' });
    expect(f.runtimes.get(operation.result.agent.runtimeId)?.state).toBe('exited');
    expect(await f.huddle.request({ t: 'inspect' })).toMatchObject({
      state: { control: { state: 'armed' }, failure: null },
    });
  } finally {
    await f.close();
  }
});

it('retains pending Stop cleanup through dispatcher loss and completes with a replacement service', async () => {
  const f = await fixture();
  const cancel = vi.spyOn(f.spawns, 'cancel').mockRejectedValue(new Error('Cleanup unavailable'));
  try {
    const agent = await completed(f);
    await f.huddle.request({ t: 'interrupt' });
    await expect
      .poll(async () => (await f.spawnRecord())?.cleanup)
      .toEqual({ state: 'pending', error: 'Cleanup unavailable' });
    const state = await f.huddle.request({ t: 'inspect' });
    if (state.t !== 'state') throw new Error('No owner state');
    expect(state.state.failure).toContain('cleanup');
    await expect(
      f.huddle.request({
        t: 'arm',
        expectedGeneration: state.state.control.generation,
        autoStart: false,
      }),
    ).rejects.toThrow();
    await f.dispatcher.close();
    await f.huddle.request({ t: 'shutdown' });
    await expect
      .poll(async () => {
        const state = await f.huddle.request({ t: 'inspect' });
        return state.t === 'state' && state.state.state;
      })
      .toBe('stopping');
    expect(f.runtimes.get(agent.runtimeId)?.state).toBe('running');
    expect(f.owner.child.exitCode).toBeNull();
    cancel.mockRestore();
    f.replace(new HuddleAgentSpawns(f.deps));
    await expect
      .poll(() => f.runtimes.get(agent.runtimeId)?.state, { timeout: 15000 })
      .toBe('exited');
    await expect.poll(() => f.owner.child.exitCode, { timeout: 15000 }).toBe(0);
    expect(f.supervisorRun).toHaveBeenCalledOnce();
  } finally {
    cancel.mockRestore();
    await f.close();
  }
});

it('observes a lost host stop reply and never attempts a second stop', async () => {
  const f = await fixture();
  const original = f.deps.controls.stop.bind(f.deps.controls);
  const stop = vi.spyOn(f.deps.controls, 'stop').mockImplementation(async (...args) => {
    await original(...args);
    throw new RuntimeConnectionLost();
  });
  try {
    const agent = await completed(f);
    await f.huddle.request({ t: 'interrupt' });
    await expect
      .poll(async () => (await f.spawnRecord())?.cleanup, { timeout: 15000 })
      .toEqual({ state: 'confirmed', outcome: 'stopped' });
    expect(stop).toHaveBeenCalledOnce();
    expect(f.runtimes.get(agent.runtimeId)?.state).toBe('exited');
  } finally {
    stop.mockRestore();
    await f.close();
  }
});

it('observes a lost cleanup confirmation without repeating host cleanup', async () => {
  const f = await fixture();
  const original = f.huddle.request.bind(f.huddle);
  let confirmations = 0;
  const request = vi.spyOn(f.huddle, 'request').mockImplementation(async (command) => {
    const result = await original(command);
    if (command.t === 'spawn-cleanup-settle') {
      confirmations++;
      throw new RuntimeConnectionLost();
    }
    return result;
  });
  const cancel = vi.spyOn(f.spawns, 'cancel');
  try {
    await completed(f);
    await f.huddle.request({ t: 'interrupt' });
    await expect
      .poll(async () => (await f.spawnRecord())?.cleanup, { timeout: 15000 })
      .toEqual({ state: 'confirmed', outcome: 'stopped' });
    expect(confirmations).toBe(1);
    expect(cancel).toHaveBeenCalledOnce();
  } finally {
    request.mockRestore();
    cancel.mockRestore();
    await f.close();
  }
});
