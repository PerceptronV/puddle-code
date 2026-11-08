import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { HUDDLE_RUNTIME_CAPABILITIES } from '@puddle/shared';
import {
  HuddleRuntimeControls,
  type HuddleCompletionBaselineCapture,
} from '../../../src/runtime/huddle/controller/controls.js';
import { huddleControlTarget } from '../../../src/runtime/huddle/controller/observations.js';
import { RuntimeConnectionLost } from '../../../src/runtime/transport/client.js';
import { huddleControllerFixture, until } from '../../helpers/huddle/controller.js';

async function fixture(capture?: HuddleCompletionBaselineCapture, plans = true) {
  const capabilities = { ...HUDDLE_RUNTIME_CAPABILITIES };
  if (!plans) delete capabilities.completionPlans;
  const f = await huddleControllerFixture(false, capabilities);
  const controls = new HuddleRuntimeControls(
    f.runtimes,
    f.connections,
    f.reconciler,
    undefined,
    capture,
  );
  return {
    ...f,
    controls,
    target: () => huddleControlTarget(f.client.state!),
    close: async () => {
      await controls.close();
      await f.close();
    },
  };
}
const authorised = () => true;

it('does not send plan requests or capture fields to older completion-capable owners', async () => {
  const capture = vi.fn<HuddleCompletionBaselineCapture>();
  const f = await fixture(capture, false);
  try {
    const request = vi.spyOn(f.client, 'request');
    await f.controls.arm(f.session.id, f.target(), false, authorised);
    expect(capture).not.toHaveBeenCalled();
    expect(request.mock.calls.find(([command]) => command.t === 'arm')?.[0]).not.toHaveProperty(
      'completionBaselines',
    );
    expect(request.mock.calls.some(([command]) => command.t === 'completion-plan')).toBe(false);
    await expect(f.client.request({ t: 'completion-plan' })).rejects.toThrow('rejected');
    expect(await f.client.request({ t: 'inspect' })).toMatchObject({
      state: { failure: null, control: { state: 'armed' } },
    });
  } finally {
    await f.close();
  }
});

it('captures completion baselines after queued review and rechecks before dispatch', async () => {
  let valid = true;
  const check = vi.fn();
  const capture = vi.fn<HuddleCompletionBaselineCapture>(
    async (_client, _state, _activation, guard) => {
      guard();
      return { baselines: [], check };
    },
  );
  const f = await fixture(capture);
  try {
    const original = f.target();
    await f.controls.apply(
      f.session.id,
      { ...f.launch.initial, id: randomUUID() },
      original,
      () => valid,
    );
    expect(capture).not.toHaveBeenCalled(); // Stopped Apply does not subscribe.
    await expect(f.controls.arm(f.session.id, original, false, () => valid)).rejects.toMatchObject({
      code: 'huddle_control_changed',
    });
    expect(capture).not.toHaveBeenCalled();
    const request = vi.spyOn(f.client, 'request');
    await f.controls.arm(f.session.id, f.target(), false, () => valid);
    expect(capture).toHaveBeenCalledOnce();
    expect(check).toHaveBeenCalledOnce();
    expect(request.mock.calls.find(([command]) => command.t === 'arm')?.[0]).toMatchObject({
      completionBaselines: [],
    });
    await f.controls.interrupt(f.session.id, f.target(), () => valid);
    const before = f.target();
    request.mockClear();
    capture.mockImplementationOnce(async () => {
      valid = false;
      return { baselines: [], check };
    });
    await expect(f.controls.arm(f.session.id, before, false, () => valid)).rejects.toMatchObject({
      code: 'upstream_expired',
    });
    expect(request.mock.calls.every(([command]) => command.t === 'inspect')).toBe(true);
    expect(f.target()).toEqual(before);
  } finally {
    await f.close();
  }
});

it('does not send lifecycle intent after a final completion target check fails', async () => {
  const capture = vi.fn<HuddleCompletionBaselineCapture>(async () => ({
    baselines: [],
    check() {
      throw new Error('Target changed during capture');
    },
  }));
  const f = await fixture(capture);
  try {
    const before = f.target(),
      request = vi.spyOn(f.client, 'request');
    await expect(f.controls.arm(f.session.id, before, false, authorised)).rejects.toThrow(
      'Target changed',
    );
    expect(request.mock.calls.every(([command]) => command.t === 'inspect')).toBe(true);
    expect(f.target()).toEqual(before);
  } finally {
    await f.close();
  }
});

it('rejects stale owner, activation and generation for every mutation before dispatch', async () => {
  const f = await fixture();
  try {
    const target = f.target();
    const request = vi.spyOn(f.client, 'request');
    for (const [change, code] of [
      [{ runtimeId: randomUUID() }, 'huddle_unavailable'],
      [{ incarnation: randomUUID() }, 'huddle_unavailable'],
      [{ generation: target.generation + 1 }, 'huddle_control_changed'],
      [{ activationId: randomUUID() }, 'huddle_control_changed'],
    ] as const) {
      const stale = { ...target, ...change };
      for (const pending of [
        () => f.controls.arm(f.session.id, stale, false, authorised),
        () =>
          f.controls.apply(
            f.session.id,
            { ...f.launch.initial, id: randomUUID() },
            stale,
            authorised,
          ),
        () => f.controls.trigger(f.session.id, stale, 'run', 'stale', f.home, authorised),
        () => f.controls.interrupt(f.session.id, stale, authorised),
      ])
        await expect(pending()).rejects.toMatchObject({ code });
    }
    expect(request.mock.calls.every(([command]) => command.t === 'inspect')).toBe(true);
    expect(f.target()).toEqual(target);
    expect(existsSync(join(f.home, 'entered'))).toBe(false);
  } finally {
    await f.close();
  }
});

it('checks queued Run against the preceding Apply and reads retained outcomes without advancing past updates', async () => {
  const f = await fixture();
  try {
    await f.controls.arm(f.session.id, f.target(), false, authorised);
    const old = f.target();
    const activation = { ...f.launch.initial, id: randomUUID() };
    const applied = f.controls.apply(f.session.id, activation, old, authorised);
    const refused = expect(
      f.controls.trigger(f.session.id, old, 'run', 'stale', f.home, authorised),
    ).rejects.toMatchObject({ code: 'huddle_control_changed' });
    await applied;
    await refused;
    expect(f.target().activationId).toBe(activation.id);
    expect(existsSync(join(f.home, 'entered'))).toBe(false);
    const accepted = await f.controls.trigger(
      f.session.id,
      f.target(),
      'run',
      'once',
      f.home,
      authorised,
    );
    await until(() => existsSync(join(f.home, 'entered')));
    const query = { collection: 'executions' as const, after: 0 };
    const before = await f.controls.records(f.session.id, f.target(), query, authorised);
    expect(before.records).toHaveLength(1);
    expect(before.records[0]!.record).toMatchObject({
      id: accepted.executionId,
      state: 'running',
      activationId: activation.id,
    });
    writeFileSync(join(f.home, 'release'), 'go');
    await until(async () => {
      const page = await f.controls.records(f.session.id, f.target(), query, authorised);
      return page.records[0]?.record.state === 'completed';
    });
    const after = await f.controls.records(f.session.id, f.target(), query, authorised);
    expect(after.next).toBe(before.next);
    expect(
      (
        await f.controls.records(
          f.session.id,
          f.target(),
          { ...query, after: after.next },
          authorised,
        )
      ).records,
    ).toEqual([]);
    const nodes = await f.controls.records(
      f.session.id,
      f.target(),
      { collection: 'invocations', after: 0, parent: accepted.executionId },
      authorised,
    );
    expect(nodes.records).toEqual(
      expect.arrayContaining([
        {
          ordinal: expect.any(Number),
          record: expect.objectContaining({
            node: 'worker',
            state: 'completed',
            result: { completed: 42 },
          }),
        },
        {
          ordinal: expect.any(Number),
          record: expect.objectContaining({ node: 'result', state: 'completed' }),
        },
      ]),
    );
    expect(
      (
        await f.controls.records(
          f.session.id,
          f.target(),
          { collection: 'invocations', after: 0, parent: randomUUID() },
          authorised,
        )
      ).records,
    ).toEqual([]);
    expect(
      (
        await f.controls.records(
          f.session.id,
          f.target(),
          { collection: 'operations', after: 0, parent: accepted.executionId },
          authorised,
        )
      ).records,
    ).toEqual([]);
    const requests = vi.spyOn(f.client, 'request');
    await expect(
      f.controls.records(
        f.session.id,
        { ...f.target(), runtimeId: randomUUID() },
        query,
        authorised,
      ),
    ).rejects.toMatchObject({ code: 'huddle_unavailable' });
    expect(requests).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it('retains one accepted execution after a lost Run reply without replaying the command', async () => {
  const f = await fixture();
  try {
    await f.controls.arm(f.session.id, f.target(), false, authorised);
    const request = f.client.request.bind(f.client);
    const calls = vi.spyOn(f.client, 'request').mockImplementation(async (command) => {
      const response = await request(command);
      if (command.t === 'run') throw new RuntimeConnectionLost();
      return response;
    });
    await expect(
      f.controls.trigger(f.session.id, f.target(), 'run', 'lost', f.home, authorised),
    ).rejects.toMatchObject({ code: 'huddle_outcome_unknown' });
    const page = await f.controls.records(
      f.session.id,
      f.target(),
      { collection: 'executions', after: 0 },
      authorised,
    );
    expect(page.records).toHaveLength(1);
    expect(calls.mock.calls.filter(([command]) => command.t === 'run')).toHaveLength(1);
    await f.controls.interrupt(f.session.id, f.target(), authorised);
  } finally {
    await f.close();
  }
});

it('rechecks authority and Stop after inspection, and discards history after authority expires', async () => {
  const f = await fixture();
  try {
    const request = f.client.request.bind(f.client);
    let valid = true;
    const calls = vi.spyOn(f.client, 'request').mockImplementation(async (command) => {
      const response = await request(command);
      if (command.t === 'inspect' || command.t === 'records') valid = false;
      return response;
    });
    await expect(
      f.controls.arm(f.session.id, f.target(), false, () => valid),
    ).rejects.toMatchObject({ code: 'upstream_expired' });
    valid = true;
    await expect(
      f.controls.records(
        f.session.id,
        f.target(),
        { collection: 'executions', after: 0 },
        () => valid,
      ),
    ).rejects.toMatchObject({ code: 'upstream_expired' });
    calls.mockImplementation(async (command) => {
      const response = await request(command);
      if (command.t === 'inspect') f.runtimes.requestHuddleStop(f.binding.runtime_id, f.session.id);
      return response;
    });
    await expect(f.controls.arm(f.session.id, f.target(), false, authorised)).rejects.toMatchObject(
      { code: 'huddle_stopping' },
    );
    expect(calls.mock.calls.some(([command]) => command.t === 'arm')).toBe(false);
  } finally {
    await f.close();
  }
});

it('retains the reviewed target and Apply input while another command holds the queue', async () => {
  const f = await fixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const request = f.client.request.bind(f.client);
    vi.spyOn(f.client, 'request').mockImplementationOnce(async (command) => {
      await held;
      return request(command);
    });
    const inspecting = f.controls.inspect(f.session.id, authorised);
    const target = f.target();
    const activation = { ...f.launch.initial, id: randomUUID() };
    const id = activation.id;
    const applying = f.controls.apply(f.session.id, activation, target, authorised);
    activation.id = randomUUID();
    activation.worktree = '/changed';
    target.activationId = randomUUID();
    target.generation++;
    release();
    await inspecting;
    expect((await applying).control.activationId).toBe(id);
  } finally {
    release();
    await f.close();
  }
});
