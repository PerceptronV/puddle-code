import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { HuddleAgentSpawns } from '../../../../src/huddle/operations/spawns/service.js';
import { HuddleSpawnStore } from '../../../../src/huddle/operations/spawns/store.js';
import { openDatabase } from '../../../../src/db/db.js';
import { huddleSpawnServiceFixture } from '../../../helpers/huddle/spawn-service.js';
import { until } from '../../../helpers/huddle/controller.js';

it('creates one real independent agent and retains readiness after a lost reply and store replacement', async () => {
  const f = huddleSpawnServiceFixture();
  try {
    const result = await f.spawns.spawn(
      f.scope,
      f.request,
      new AbortController().signal,
      () => true,
    );
    expect(result.agent).toMatchObject({ projectId: f.project.id, worktree: f.request.worktree });
    expect(result.receipt).toMatch(/^[a-f0-9]{64}$/);
    expect(f.run).toHaveBeenCalledOnce();
    const replacement = new HuddleAgentSpawns(f.deps);
    expect(replacement.observe(f.scope, f.request, () => true)).toEqual(result);
    await expect(
      replacement.spawn(f.scope, f.request, new AbortController().signal, () => true),
    ).rejects.toThrow('already admitted');
    expect(f.run).toHaveBeenCalledOnce();
    expect(await replacement.cancel(f.scope, f.request, () => true)).toEqual({ state: 'stopped' });
    expect(replacement.observe(f.scope, f.request, () => true)).toEqual(result);
    const reopened = openDatabase(f.paths.dbFile);
    try {
      expect(new HuddleSpawnStore(reopened).bind(f.scope, f.request, () => true).outcome()).toEqual(
        result,
      );
    } finally {
      reopened.close();
    }
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM puddlang_runs').get()).toEqual({ n: 0 });
  } finally {
    await f.close();
  }
});

it('records one exact cleanup attempt and observes its result without another stop dispatch', async () => {
  const f = huddleSpawnServiceFixture();
  try {
    await f.spawns.spawn(f.scope, f.request, new AbortController().signal, () => true);
    let authorised = true;
    const original = f.controls.stop.bind(f.controls);
    const stop = vi.spyOn(f.controls, 'stop').mockImplementation(async (...args) => {
      await original(...args);
      authorised = false;
    });
    await expect(f.spawns.cancel(f.scope, f.request, () => authorised)).rejects.toThrow(
      'authority expired',
    );
    expect(
      f.db.prepare('SELECT stop_requested, stop_attempted FROM huddle_runtime_spawns').get(),
    ).toEqual({ stop_requested: 1, stop_attempted: 1 });
    expect(await f.spawns.cancel(f.scope, f.request, () => true)).toEqual({ state: 'stopped' });
    expect(stop).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it('does not stop a replacement agent resumed in the original placement', async () => {
  const f = huddleSpawnServiceFixture();
  try {
    const result = await f.spawns.spawn(
      f.scope,
      f.request,
      new AbortController().signal,
      () => true,
    );
    await f.spawns.cancel(f.scope, f.request, () => true);
    await f.service.resume(result.agent.sessionId);
    const replacement = f.runtimes.ownerOf(result.agent.sessionId)!;
    expect(replacement.runtime_id).not.toBe(result.agent.runtimeId);
    expect(await f.spawns.cancel(f.scope, f.request, () => true)).toEqual({ state: 'stopped' });
    expect(f.runtimes.get(replacement.runtime_id)?.state).toBe('running');
    expect(f.spawns.observe(f.scope, f.request, () => true)).toEqual(result);
    await f.controls.stop(result.agent.sessionId, () => true);
  } finally {
    await f.close();
  }
});

it('keeps an uncertain stop observation-only across service replacement', async () => {
  const f = huddleSpawnServiceFixture();
  try {
    const result = await f.spawns.spawn(
      f.scope,
      f.request,
      new AbortController().signal,
      () => true,
    );
    let attempted = 0;
    const spy = vi.spyOn(f.controls, 'stop').mockImplementation(async (_id, authorised, review) => {
      expect(authorised()).toBe(true);
      review!(f.connections.get(result.agent.runtimeId)!.state!);
      attempted++;
      throw new Error('Fixture stop acknowledgement lost');
    });
    await expect(f.spawns.cancel(f.scope, f.request, () => true)).rejects.toThrow(
      'acknowledgement lost',
    );
    const replacement = new HuddleAgentSpawns(f.deps);
    await expect(replacement.cancel(f.scope, f.request, () => true)).rejects.toThrow(
      'already attempted',
    );
    expect(attempted).toBe(1);
    expect(f.runtimes.get(result.agent.runtimeId)?.state).toBe('running');
    spy.mockRestore();
    // Explicit fixture teardown is outside the consumed huddle operation.
    await f.controls.stop(result.agent.sessionId, () => true);
    expect(await replacement.cancel(f.scope, f.request, () => true)).toEqual({ state: 'stopped' });
  } finally {
    await f.close();
  }
});

it('bounds readiness waiting without replaying or automatically stopping an accepted launch', async () => {
  const f = huddleSpawnServiceFixture(20);
  const inspect = vi.spyOn(f.deps.turns, 'inspect').mockReturnValue(null);
  try {
    await expect(
      f.spawns.spawn(f.scope, f.request, new AbortController().signal, () => true),
    ).rejects.toThrow('did not become ready');
    expect(f.run).toHaveBeenCalledOnce();
    const bound = f.store.bind(f.scope, f.request, () => true);
    expect(bound.outcome()).toBeNull();
    expect(f.runtimes.get(bound.observe()!.runtime!.runtime_id)?.state).toBe('running');
    inspect.mockRestore();
    await until(() => !!f.spawns.observe(f.scope, f.request, () => true));
    await f.spawns.cancel(f.scope, f.request, () => true);
  } finally {
    inspect.mockRestore();
    await f.close();
  }
});

it('keeps an accepted runtime on caller disconnection, then reconciles readiness without another creation', async () => {
  const f = huddleSpawnServiceFixture();
  const controller = new AbortController();
  const create = f.service.create.bind(f.service);
  vi.spyOn(f.service, 'create').mockImplementation(async (...args) => {
    await create(...args);
    controller.abort(new Error('Fixture controller disconnected'));
    throw new Error('Creation reply lost');
  });
  try {
    await expect(f.spawns.spawn(f.scope, f.request, controller.signal, () => true)).rejects.toThrow(
      'reply lost',
    );
    const admitted = f.store.bind(f.scope, f.request, () => true).observe()!;
    expect(f.runtimes.get(admitted.runtime!.runtime_id)?.state).toBe('running');
    expect(admitted.stopRequested).toBe(false);
    const replacement = new HuddleAgentSpawns(f.deps);
    await until(() => !!replacement.observe(f.scope, f.request, () => true));
    expect(f.run).toHaveBeenCalledOnce();
    await replacement.cancel(f.scope, f.request, () => true);
  } finally {
    await f.close();
  }
});

it('fences cancellation before asynchronous creation returns and does not launch an agent afterwards', async () => {
  const f = huddleSpawnServiceFixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const create = f.service.create.bind(f.service);
  const entered = vi.spyOn(f.service, 'create').mockImplementation(async (...args) => {
    await gate;
    return create(...args);
  });
  try {
    const pending = f.spawns.spawn(f.scope, f.request, new AbortController().signal, () => true);
    const rejected = expect(pending).rejects.toThrow('authority expired');
    await until(() => entered.mock.calls.length === 1);
    expect(await f.spawns.cancel(f.scope, f.request, () => true)).toEqual({ state: 'pending' });
    release();
    await rejected;
    expect(f.store.bind(f.scope, f.request, () => true).observe()).toBeNull();
    expect(f.run).not.toHaveBeenCalled();
  } finally {
    release();
    await f.close();
  }
});

it('refuses changed cleanup scope and expired queued authority without consuming a stop attempt', async () => {
  const f = huddleSpawnServiceFixture();
  try {
    const result = await f.spawns.spawn(
      f.scope,
      f.request,
      new AbortController().signal,
      () => true,
    );
    await expect(
      f.spawns.cancel({ ...f.scope, invocationId: randomUUID() }, f.request, () => true),
    ).rejects.toThrow('intent changed');
    let allowed = true;
    const stop = f.controls.stop.bind(f.controls);
    const spy = vi.spyOn(f.controls, 'stop').mockImplementation(async (...args) => {
      allowed = false;
      return stop(...args);
    });
    await expect(f.spawns.cancel(f.scope, f.request, () => allowed)).rejects.toThrow(
      'authority expired',
    );
    expect(f.db.prepare('SELECT stop_attempted FROM huddle_runtime_spawns').get()).toEqual({
      stop_attempted: 0,
    });
    expect(f.runtimes.get(result.agent.runtimeId)?.state).toBe('running');
    spy.mockRestore();
    await f.spawns.cancel(f.scope, f.request, () => true);
  } finally {
    await f.close();
  }
});
