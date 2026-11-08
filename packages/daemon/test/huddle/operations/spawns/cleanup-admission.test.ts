import { expect, it, vi } from 'vitest';
import { spawnDispatcherFixture } from '../../../helpers/huddle/spawn-dispatch.js';

it('cleans an admitted agent when Interrupt arrives before spawn readiness can be returned', async () => {
  const f = await spawnDispatcherFixture();
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
    await f.huddle.request({ t: 'interrupt' });
    await expect
      .poll(async () => (await f.spawnRecord())?.cleanup, { timeout: 15000 })
      .toEqual({ state: 'confirmed', outcome: 'stopped' });
    expect(await f.outcome()).toEqual(['interrupted']);
    expect(f.runtimes.get(runtimeId!)?.state).toBe('exited');
    expect(f.supervisorRun).toHaveBeenCalledOnce();
    expect(f.db.prepare('SELECT outcome, stop_attempted FROM huddle_runtime_spawns').get()).toEqual(
      { outcome: null, stop_attempted: 1 },
    );
  } finally {
    observe.mockRestore();
    await f.close();
  }
});
