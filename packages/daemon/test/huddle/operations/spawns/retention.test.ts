import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { spawnDispatcherFixture } from '../../../helpers/huddle/spawn-dispatch.js';
import { HuddleRevisionStore } from '../../../../src/runtime/huddle/state/revisions.js';
import { huddleRevisionDigest } from '../../../../src/huddle/definitions/revision.js';

it('retains admitted agents without replay when interrupted before readiness is returned', async () => {
  const f = await spawnDispatcherFixture((snapshot) => {
    snapshot.definition.execution.cleanup = 'retain-owned';
  });
  const observe = vi.spyOn(f.spawns, 'observe').mockReturnValue(null);
  const cancel = vi.spyOn(f.spawns, 'cancel');
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
    await f.huddle.request({ t: 'interrupt' });
    await expect.poll(async () => (await f.spawnRecord())?.cleanup).toEqual({ state: 'released' });
    await f.dispatcher.close();
    f.replace();
    await f.controls.huddles.stop(f.scope.owner.session_id, () => true);
    expect(f.runtimes.get(runtimeId!)?.state).toBe('running');
    expect(f.supervisorRun).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
    expect(
      f.db
        .prepare('SELECT outcome, stop_requested, stop_attempted FROM huddle_runtime_spawns')
        .get(),
    ).toEqual({ outcome: null, stop_requested: 0, stop_attempted: 0 });
  } finally {
    observe.mockRestore();
    cancel.mockRestore();
    await f.close();
  }
});

it('keeps each execution cleanup policy across Apply and leaves retained agents running after Stop', async () => {
  const f = await spawnDispatcherFixture((snapshot) => {
    snapshot.definition.execution.cleanup = 'retain-owned';
  });
  try {
    await f.run();
    await expect.poll(() => f.outcome(), { timeout: 15000 }).toEqual(['completed']);
    const first = await f.spawnRecord();
    if (!first?.result || !('agent' in first.result)) throw new Error('No retained agent');
    const snapshot = structuredClone(f.snapshot);
    snapshot.definition.execution.cleanup = 'stop-owned';
    snapshot.files['huddle.json'] = JSON.stringify(snapshot.definition);
    snapshot.digest = huddleRevisionDigest(snapshot.files, snapshot.components);
    new HuddleRevisionStore(f.home, f.scope.owner.runtime_id, snapshot.definition.id).publish(
      snapshot,
    );
    const state = await f.huddle.request({ t: 'inspect' });
    if (state.t !== 'state') throw new Error('No owner state');
    await f.huddle.request({
      t: 'apply',
      expectedGeneration: state.state.control.generation,
      activation: { ...f.launch.initial, id: randomUUID(), revision: snapshot.digest },
    });
    await f.run();
    await expect.poll(() => f.outcome(), { timeout: 15000 }).toEqual(['completed', 'completed']);
    const page = await f.huddle.request({ t: 'spawn-page', after: 0 });
    if (page.t !== 'spawn-page') throw new Error('No spawn records');
    const second = page.page.records[1]?.operation;
    if (!second?.result || !('agent' in second.result)) throw new Error('No second agent');
    await f.controls.huddles.stop(f.scope.owner.session_id, () => true);
    expect(f.runtimes.get(first.result.agent.runtimeId)?.state).toBe('running');
    expect(f.runtimes.get(second.result.agent.runtimeId)?.state).toBe('exited');
    expect(f.runtimes.get(f.scope.owner.runtime_id)?.state).toBe('exited');
    expect(
      f.db
        .prepare('SELECT stop_attempted FROM huddle_runtime_spawns WHERE runtime_id = ?')
        .get(first.result.agent.runtimeId),
    ).toEqual({ stop_attempted: 0 });
    expect(
      f.db
        .prepare('SELECT stop_attempted FROM huddle_runtime_spawns WHERE runtime_id = ?')
        .get(second.result.agent.runtimeId),
    ).toEqual({ stop_attempted: 1 });
  } finally {
    await f.close();
  }
});
